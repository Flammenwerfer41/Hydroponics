import { getPlugStatus, setAirConditioner, setPlugPower } from "../switchbot/client.js";
import {
  AC_ACTUATOR_ID,
  LIGHT_ACTUATOR_ID,
  clearExpiredOverride,
  createCommand,
  finishCommand,
  readSchedule,
  setOverride,
  storeTelemetry
} from "./store.js";

const JST_OFFSET_MINUTES = 9 * 60;

function jstMinute(now) {
  const shifted = new Date(now.getTime() + JST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function scheduledPower(schedule, now = new Date()) {
  if (!schedule || !Number(schedule.enabled)) return null;
  if (schedule.override_state && Date.parse(schedule.override_until) > now.getTime()) {
    return schedule.override_state;
  }
  const minute = jstMinute(now);
  const on = Number(schedule.on_minute);
  const off = Number(schedule.off_minute);
  if (on === off) return null;
  const active = on < off ? minute >= on && minute < off : minute >= on || minute < off;
  return active ? "on" : "off";
}

export function nextTransition(schedule, now = new Date()) {
  const shifted = new Date(now.getTime() + JST_OFFSET_MINUTES * 60_000);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const candidates = [Number(schedule.on_minute), Number(schedule.off_minute)]
    .map((target) => ({ target, delta: (target - minute + 1440) % 1440 || 1440 }))
    .sort((left, right) => left.delta - right.delta);
  const transition = new Date(now.getTime() + candidates[0].delta * 60_000);
  transition.setUTCSeconds(0, 0);
  return transition.toISOString();
}

async function runCommand(database, actuatorId, actorType, actorId, command, parameters, execute) {
  const started = new Date();
  const id = await createCommand(
    database, actuatorId, actorType, actorId, command, parameters, started
  );
  try {
    const result = await execute();
    await finishCommand(database, id, "sent", result?.statusCode ?? 100, result?.message, new Date());
    return { id, result };
  } catch (error) {
    await finishCommand(
      database, id, "failed", error.providerStatus ?? null, error.message, new Date()
    );
    throw error;
  }
}

export async function pollAndReconcile(environment, now = new Date()) {
  const database = environment.HYDROPONICS_DB;
  await clearExpiredOverride(database, now);
  const [schedule, telemetry] = await Promise.all([
    readSchedule(database),
    getPlugStatus(environment)
  ]);
  await storeTelemetry(database, telemetry, now);
  const desired = scheduledPower(schedule, now);
  if (!desired || telemetry.state === desired) {
    return { telemetry, desired, command: null };
  }
  const command = await runCommand(
    database,
    LIGHT_ACTUATOR_ID,
    "schedule",
    "cloudflare-cron",
    `power_${desired}`,
    { desired, observed: telemetry.state },
    () => setPlugPower(environment, desired)
  );
  const confirmed = await getPlugStatus(environment);
  await storeTelemetry(database, confirmed, new Date());
  await finishCommand(
    database,
    command.id,
    confirmed.state === desired ? "confirmed" : "sent",
    confirmed.providerStatus,
    confirmed.state === desired ? "state confirmed" : "state not yet confirmed",
    new Date()
  );
  return { telemetry: confirmed, desired, command: command.id };
}

export async function manualLightCommand(environment, power, actor, now = new Date()) {
  const database = environment.HYDROPONICS_DB;
  const schedule = await readSchedule(database);
  const overrideUntil = nextTransition(schedule, now);
  const command = await runCommand(
    database,
    LIGHT_ACTUATOR_ID,
    "admin",
    actor,
    `power_${power}`,
    { power, override_until: overrideUntil },
    () => setPlugPower(environment, power)
  );
  await setOverride(database, power, overrideUntil, actor, now);
  const telemetry = await getPlugStatus(environment);
  await storeTelemetry(database, telemetry, new Date());
  await finishCommand(
    database,
    command.id,
    telemetry.state === power ? "confirmed" : "sent",
    telemetry.providerStatus,
    telemetry.state === power ? "state confirmed" : "state not yet confirmed",
    new Date()
  );
  return { command_id: command.id, override_until: overrideUntil, telemetry };
}

export async function manualAcCommand(environment, settings, actor) {
  const commandName = settings.power === "off" ? "power_off" : "set_all";
  const result = await runCommand(
    environment.HYDROPONICS_DB,
    AC_ACTUATOR_ID,
    "admin",
    actor,
    commandName,
    settings,
    () => setAirConditioner(environment, settings)
  );
  return { command_id: result.id, accepted: true };
}
