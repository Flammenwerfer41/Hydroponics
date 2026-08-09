export const LIGHT_ACTUATOR_ID = "tower-01-grow-light";
export const AC_ACTUATOR_ID = "room-air-conditioner";

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

export async function readSchedule(database) {
  return database.prepare(`
    SELECT actuator_id, enabled, timezone, on_minute, off_minute,
      override_state, override_until, revision, updated_at, updated_by
    FROM automation_settings
    WHERE actuator_id = ?1
  `).bind(LIGHT_ACTUATOR_ID).first();
}

export async function updateSchedule(database, settings, actor, now) {
  await database.prepare(`
    UPDATE automation_settings
    SET enabled = ?1, on_minute = ?2, off_minute = ?3,
      override_state = NULL, override_until = NULL,
      revision = revision + 1, updated_at = ?4, updated_by = ?5
    WHERE actuator_id = ?6
  `).bind(
    settings.enabled ? 1 : 0,
    settings.onMinute,
    settings.offMinute,
    now.toISOString(),
    actor,
    LIGHT_ACTUATOR_ID
  ).run();
  return readSchedule(database);
}

export async function setOverride(database, power, until, actor, now) {
  await database.prepare(`
    UPDATE automation_settings
    SET override_state = ?1, override_until = ?2,
      revision = revision + 1, updated_at = ?3, updated_by = ?4
    WHERE actuator_id = ?5
  `).bind(power, until, now.toISOString(), actor, LIGHT_ACTUATOR_ID).run();
}

export async function clearExpiredOverride(database, now) {
  await database.prepare(`
    UPDATE automation_settings
    SET override_state = NULL, override_until = NULL,
      revision = revision + 1, updated_at = ?1, updated_by = 'scheduler'
    WHERE actuator_id = ?2 AND override_until IS NOT NULL AND override_until <= ?1
  `).bind(now.toISOString(), LIGHT_ACTUATOR_ID).run();
}

export async function storeTelemetry(database, telemetry, now = new Date()) {
  await database.prepare(`
    INSERT OR IGNORE INTO actuator_telemetry (
      actuator_id, observed_at, received_at, power_state, power_w,
      voltage_v, current_a, runtime_minutes, quality, provider_status, payload_json
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'valid', ?9, ?10)
  `).bind(
    LIGHT_ACTUATOR_ID,
    telemetry.observedAt,
    now.toISOString(),
    telemetry.state,
    telemetry.powerW,
    telemetry.voltageV,
    telemetry.currentA,
    telemetry.runtimeMinutes,
    telemetry.providerStatus,
    JSON.stringify(telemetry.raw || {})
  ).run();
}

export async function latestTelemetry(database) {
  return database.prepare(`
    SELECT observed_at, received_at, power_state, power_w, voltage_v,
      current_a, runtime_minutes, quality, provider_status
    FROM actuator_telemetry
    WHERE actuator_id = ?1
    ORDER BY observed_at DESC, id DESC
    LIMIT 1
  `).bind(LIGHT_ACTUATOR_ID).first();
}

export async function telemetryHistory(database, from, to, granularity) {
  if (granularity === "hourly") {
    const result = await database.prepare(`
      SELECT strftime('%Y-%m-%dT%H:00:00+09:00', observed_at, '+9 hours') AS time,
        AVG(CASE power_state WHEN 'on' THEN 1.0 WHEN 'off' THEN 0.0 END) AS light_status,
        AVG(power_w) AS light_power,
        MAX(runtime_minutes) AS light_uptime,
        COUNT(*) AS samples
      FROM actuator_telemetry
      WHERE actuator_id = ?1 AND observed_at >= ?2 AND observed_at < ?3
      GROUP BY time ORDER BY time ASC
    `).bind(LIGHT_ACTUATOR_ID, from, to).all();
    return rows(result);
  }
  const result = await database.prepare(`
    SELECT observed_at AS time,
      CASE power_state WHEN 'on' THEN 1 WHEN 'off' THEN 0 END AS light_status,
      power_w AS light_power, runtime_minutes AS light_uptime
    FROM actuator_telemetry
    WHERE actuator_id = ?1 AND observed_at >= ?2 AND observed_at < ?3
    ORDER BY observed_at ASC, id ASC
    LIMIT 25000
  `).bind(LIGHT_ACTUATOR_ID, from, to).all();
  return rows(result);
}

export async function createCommand(database, actuatorId, actorType, actorId, command, parameters, now) {
  const id = crypto.randomUUID();
  await database.prepare(`
    INSERT INTO actuator_commands (
      id, actuator_id, requested_at, actor_type, actor_id,
      command, parameters_json, status
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')
  `).bind(
    id, actuatorId, now.toISOString(), actorType, actorId,
    command, JSON.stringify(parameters || {})
  ).run();
  return id;
}

export async function finishCommand(database, id, status, providerStatus, message, now) {
  await database.prepare(`
    UPDATE actuator_commands
    SET status = ?1, provider_status = ?2, provider_message = ?3, completed_at = ?4
    WHERE id = ?5
  `).bind(status, providerStatus, message || null, now.toISOString(), id).run();
}

export async function recentCommands(database, limit = 20) {
  const result = await database.prepare(`
    SELECT id, actuator_id, requested_at, actor_type, actor_id, command,
      parameters_json, status, provider_status, provider_message, completed_at
    FROM actuator_commands
    ORDER BY requested_at DESC
    LIMIT ?1
  `).bind(limit).all();
  return rows(result).map((row) => ({
    ...row,
    parameters: JSON.parse(row.parameters_json || "{}"),
    parameters_json: undefined
  }));
}

export async function latestSensorSnapshot(database) {
  const result = await database.prepare(`
    WITH ranked AS (
      SELECT mv.metric, mv.value, mv.quality, r.measured_at,
        ROW_NUMBER() OVER (PARTITION BY mv.metric ORDER BY r.measured_at DESC, r.id DESC) AS rank
      FROM measurement_values mv
      JOIN readings r ON r.id = mv.reading_pk
      WHERE r.device_id = 'esp32-01'
        AND mv.metric IN ('air_temperature', 'humidity', 'water_temperature', 'wifi_rssi')
        AND mv.quality = 'valid'
    )
    SELECT metric, value, quality, measured_at FROM ranked WHERE rank = 1
  `).all();
  return Object.fromEntries(rows(result).map((row) => [row.metric, {
    value: row.value,
    quality: row.quality,
    measured_at: row.measured_at
  }]));
}
