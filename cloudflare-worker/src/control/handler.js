import { authenticateAdmin } from "../admin/access.js";
import {
  latestSensorSnapshot,
  latestTelemetry,
  readSchedule,
  recentCommands,
  telemetryHistory,
  updateSchedule
} from "./store.js";
import { manualAcCommand, manualLightCommand, nextTransition, scheduledPower } from "./service.js";

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function publicResponse(body, status = 200) {
  return response(body, status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  });
}

function error(code, message, status = 400) {
  return response({ error: { code, message } }, status);
}

async function jsonBody(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  }
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 });
  }
}

function minute(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minuteValue] = value.split(":").map(Number);
  if (hour > 23 || minuteValue > 59) return null;
  return hour * 60 + minuteValue;
}

function formatMinute(value) {
  const number = Number(value);
  return `${String(Math.floor(number / 60)).padStart(2, "0")}:${String(number % 60).padStart(2, "0")}`;
}

function validateAc(body) {
  if (body?.power === "off") return { power: "off" };
  const mode = Number(body?.mode);
  const fan = Number(body?.fan);
  const temperature = Number(body?.temperature);
  if (body?.power !== "on" || ![1, 2, 3, 4, 5].includes(mode) ||
      ![1, 2, 3, 4].includes(fan) || !Number.isInteger(temperature) ||
      temperature < 16 || temperature > 30) {
    return null;
  }
  return { power: "on", mode, fan, temperature };
}

function historyTimestamp(value, name) {
  if (value === null) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${name} must include a timezone offset`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be a valid timestamp`);
  return new Date(milliseconds);
}

export function lightHistoryRange(url, now = new Date()) {
  const granularity = url.searchParams.get("granularity") || "raw";
  if (!["raw", "hourly"].includes(granularity)) {
    throw new Error("granularity must be raw or hourly");
  }

  const hasExplicitRange = url.searchParams.has("from") || url.searchParams.has("to");
  if (hasExplicitRange && url.searchParams.has("days")) {
    throw new Error("days cannot be combined with from or to");
  }

  let from;
  let to;
  if (hasExplicitRange) {
    to = historyTimestamp(url.searchParams.get("to"), "to") || new Date(now);
    from = historyTimestamp(url.searchParams.get("from"), "from");
    if (!from) throw new Error("from is required when using an explicit range");
  } else {
    const days = Number(url.searchParams.get("days") || 2);
    if (!Number.isInteger(days) || days < 1 || days > 31) {
      throw new Error("days must be between 1 and 31");
    }
    to = new Date(now);
    from = new Date(to.getTime() - days * 86400000);
  }

  if (from.getTime() >= to.getTime()) throw new Error("from must be earlier than to");
  if (to.getTime() - from.getTime() > 31 * 86400000) {
    throw new Error("light history range cannot exceed 31 days");
  }
  return { granularity, from, to };
}

export async function handlePublicLight(request, environment, path) {
  if (request.method !== "GET") return publicResponse({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405);
  if (!environment.HYDROPONICS_DB) return publicResponse({ error: { code: "database_unavailable", message: "Database unavailable" } }, 503);
  if (path === "/v1/light/current") {
    return publicResponse({ schema_version: 1, telemetry: await latestTelemetry(environment.HYDROPONICS_DB) });
  }
  if (path === "/v1/light/history") {
    const url = new URL(request.url);
    let range;
    try {
      range = lightHistoryRange(url);
    } catch (caught) {
      return publicResponse({ error: { code: "invalid_query", message: caught.message } }, 400);
    }
    const points = await telemetryHistory(
      environment.HYDROPONICS_DB, range.from.toISOString(), range.to.toISOString(), range.granularity
    );
    return publicResponse({
      schema_version: 1,
      granularity: range.granularity,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      points
    });
  }
  return publicResponse({ error: { code: "not_found", message: "Not found" } }, 404);
}

export async function handleAdmin(request, environment, path) {
  if (!environment.HYDROPONICS_DB) return error("database_unavailable", "Database unavailable", 503);
  const admin = await authenticateAdmin(request, environment);
  if (!admin) return error("unauthorized", "Cloudflare Access authentication is required", 401);
  const actor = admin.email || admin.id;

  try {
    if (request.method === "GET" && path === "/admin/api/status") {
      const [schedule, telemetry, sensors, commands] = await Promise.all([
        readSchedule(environment.HYDROPONICS_DB),
        latestTelemetry(environment.HYDROPONICS_DB),
        latestSensorSnapshot(environment.HYDROPONICS_DB),
        recentCommands(environment.HYDROPONICS_DB, 20)
      ]);
      return response({
        schema_version: 1,
        admin: { email: admin.email },
        sensors,
        light: {
          telemetry,
          schedule: {
            enabled: Boolean(schedule?.enabled),
            timezone: schedule?.timezone || "Asia/Tokyo",
            on: formatMinute(schedule?.on_minute ?? 420),
            off: formatMinute(schedule?.off_minute ?? 1260),
            override_state: schedule?.override_state || null,
            override_until: schedule?.override_until || null,
            desired_state: scheduledPower(schedule),
            next_transition: schedule?.enabled ? nextTransition(schedule) : null
          }
        },
        air_conditioner: {
          state_kind: "last_command",
          last_command: commands.find((item) => item.actuator_id === "room-air-conditioner") || null
        },
        commands
      });
    }

    if (request.method === "PUT" && path === "/admin/api/light/schedule") {
      const body = await jsonBody(request);
      const onMinute = minute(body?.on);
      const offMinute = minute(body?.off);
      if (typeof body?.enabled !== "boolean" || onMinute === null || offMinute === null || onMinute === offMinute) {
        return error("invalid_schedule", "enabled and two distinct HH:MM times are required", 422);
      }
      const schedule = await updateSchedule(
        environment.HYDROPONICS_DB,
        { enabled: body.enabled, onMinute, offMinute },
        actor,
        new Date()
      );
      return response({ schema_version: 1, schedule });
    }

    if (request.method === "POST" && path === "/admin/api/light/command") {
      const body = await jsonBody(request);
      if (!["on", "off"].includes(body?.power)) {
        return error("invalid_command", "power must be on or off", 422);
      }
      return response({ schema_version: 1, ...(await manualLightCommand(environment, body.power, actor)) });
    }

    if (request.method === "POST" && path === "/admin/api/ac/command") {
      const settings = validateAc(await jsonBody(request));
      if (!settings) return error("invalid_command", "Invalid air-conditioner settings", 422);
      return response({ schema_version: 1, ...(await manualAcCommand(environment, settings, actor)) });
    }

    return error("not_found", "Not found", 404);
  } catch (caught) {
    console.error("Admin control request failed", caught);
    return error("control_failed", caught.message || "Control request failed", caught.status || 502);
  }
}
