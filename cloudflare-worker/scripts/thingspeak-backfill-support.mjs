import { createHash } from "node:crypto";

export const CHANNEL_ID = 3436358;
export const DEVICE_ID = "esp32-01";

export const FIELD_DEFINITIONS = Object.freeze([
  Object.freeze({ field: "field1", metric: "air_temperature", unit: "degC", sensor: "tower-01-bme280-temperature" }),
  Object.freeze({ field: "field2", metric: "humidity", unit: "percent", sensor: "tower-01-bme280-humidity" }),
  Object.freeze({ field: "field3", metric: "pressure", unit: "hPa", sensor: "tower-01-bme280-pressure" }),
  Object.freeze({ field: "field4", metric: "wifi_rssi", unit: "dBm", sensor: "tower-01-wifi-rssi" }),
  Object.freeze({ field: "field5", metric: "water_temperature", unit: "degC", sensor: "tower-01-ds18b20-water" }),
  Object.freeze({ field: "field6", metric: "light_status", unit: "state", sensor: "tower-01-switchbot-status" }),
  Object.freeze({ field: "field7", metric: "light_power", unit: "W", sensor: "tower-01-switchbot-power" }),
  Object.freeze({ field: "field8", metric: "light_uptime", unit: "min", sensor: "tower-01-switchbot-uptime" })
]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function feedToReading(feed) {
  const entryId = Number(feed?.entry_id);
  const measured = new Date(feed?.created_at);
  if (!Number.isSafeInteger(entryId) || entryId < 1 || Number.isNaN(measured.getTime())) {
    throw new Error("ThingSpeak feed has an invalid identity or timestamp");
  }

  const measuredAt = measured.toISOString();
  const values = FIELD_DEFINITIONS.map((definition) => {
    const value = finiteNumber(feed[definition.field]);
    return {
      ...definition,
      value,
      quality: value === null ? "missing" : "valid",
      diagnostic: value === null ? "thingspeak_field_missing" : null
    };
  });
  const canonical = JSON.stringify({
    source: "ThingSpeak",
    channel_id: CHANNEL_ID,
    entry_id: entryId,
    measured_at: measuredAt,
    values: Object.fromEntries(values.map(({ metric, value }) => [metric, value]))
  });

  return {
    entryId,
    readingId: `thingspeak:${CHANNEL_ID}:${entryId}`,
    measuredAt,
    payloadSha256: sha256(canonical),
    values
  };
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQL number must be finite");
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function readingSql(reading) {
  const readingId = sqlLiteral(reading.readingId);
  const statements = [`INSERT OR IGNORE INTO readings (
  device_id, reading_id, boot_id, sequence, measured_at, received_at,
  firmware_version, reset_reason, source, payload_sha256, remote_address_hash
) VALUES (
  ${sqlLiteral(DEVICE_ID)}, ${readingId}, NULL, NULL,
  ${sqlLiteral(reading.measuredAt)}, ${sqlLiteral(reading.measuredAt)},
  NULL, NULL, 'thingspeak_backfill', ${sqlLiteral(reading.payloadSha256)}, NULL
);`];

  for (const field of reading.values) {
    statements.push(`INSERT OR IGNORE INTO measurement_values (
  reading_pk, sensor_id, metric, value, unit, quality, diagnostic
)
SELECT id, ${sqlLiteral(field.sensor)}, ${sqlLiteral(field.metric)},
  ${sqlLiteral(field.value)}, ${sqlLiteral(field.unit)}, ${sqlLiteral(field.quality)},
  ${sqlLiteral(field.diagnostic)}
FROM readings
WHERE device_id = ${sqlLiteral(DEVICE_ID)} AND reading_id = ${readingId};`);
  }
  return statements.join("\n");
}

export function batchSql(readings) {
  return `${readings.map(readingSql).join("\n")}
`;
}

export function utcWindows(start, end) {
  const from = new Date(start);
  const until = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || from >= until) {
    throw new Error("Backfill range is invalid");
  }
  const windows = [];
  let cursor = from;
  while (cursor < until) {
    const nextMidnight = new Date(Date.UTC(
      cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1
    ));
    const next = nextMidnight < until ? nextMidnight : until;
    windows.push({ start: cursor.toISOString(), end: next.toISOString() });
    cursor = next;
  }
  return windows;
}

export function uniqueFeeds(feeds) {
  const byEntry = new Map();
  for (const feed of feeds) {
    const entryId = Number(feed?.entry_id);
    if (Number.isSafeInteger(entryId) && entryId > 0) byEntry.set(entryId, feed);
  }
  return [...byEntry.values()];
}

export function remainingReadings(readings, progress) {
  const count = Number(progress?.count ?? 0);
  const oldest = progress?.oldest ? Date.parse(progress.oldest) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1 || Number.isNaN(oldest)) return readings;
  if (count === readings.length) return [];

  const older = readings.filter((reading) => Date.parse(reading.measuredAt) < oldest);
  return count + older.length === readings.length ? older : readings;
}
