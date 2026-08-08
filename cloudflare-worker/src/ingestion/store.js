import { sha256Hex } from "./auth.js";

function canonicalReading(reading) {
  return JSON.stringify({
    schema_version: reading.schemaVersion,
    reading_id: reading.readingId,
    boot_id: reading.bootId,
    sequence: reading.sequence,
    measured_at: reading.measuredAt,
    firmware_version: reading.firmwareVersion,
    reset_reason: reading.resetReason,
    values: reading.values
  });
}

export async function persistReading(
  database,
  deviceId,
  reading,
  receivedAt,
  remoteAddressHash = null
) {
  const payloadHash = await sha256Hex(canonicalReading(reading));
  const statements = [
    database.prepare(`
      INSERT OR IGNORE INTO readings (
        device_id, reading_id, boot_id, sequence, measured_at, received_at,
        firmware_version, reset_reason, payload_sha256, remote_address_hash
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      deviceId,
      reading.readingId,
      reading.bootId,
      reading.sequence,
      reading.measuredAt,
      receivedAt,
      reading.firmwareVersion,
      reading.resetReason,
      payloadHash,
      remoteAddressHash
    )
  ];

  const valueRows = reading.values.map((_, index) => {
    const first = index * 5 + 1;
    return `(?${first}, ?${first + 1}, ?${first + 2}, ?${first + 3}, ?${first + 4})`;
  }).join(", ");
  const valueBindings = reading.values.flatMap((field) => [
    field.metric,
    field.value,
    field.unit,
    field.quality,
    field.diagnostic
  ]);
  const identityParameter = valueBindings.length + 1;
  statements.push(database.prepare(`
    WITH incoming(metric, value, unit, quality, diagnostic) AS (
      VALUES ${valueRows}
    )
    INSERT OR IGNORE INTO measurement_values (
      reading_pk, metric, value, unit, quality, diagnostic
    )
    SELECT r.id, incoming.metric, incoming.value, incoming.unit,
      incoming.quality, incoming.diagnostic
    FROM readings r
    CROSS JOIN incoming
    WHERE r.device_id = ?${identityParameter}
      AND r.reading_id = ?${identityParameter + 1}
      AND r.payload_sha256 = ?${identityParameter + 2}
  `).bind(...valueBindings, deviceId, reading.readingId, payloadHash));

  const results = await database.batch(statements);
  const inserted = Number(results[0]?.meta?.changes ?? 0) > 0;
  const existing = await database.prepare(`
    SELECT id, payload_sha256
    FROM readings
    WHERE device_id = ?1 AND reading_id = ?2
    LIMIT 1
  `).bind(deviceId, reading.readingId).first();

  if (inserted) return { status: "accepted" };
  if (existing?.payload_sha256 === payloadHash) return { status: "duplicate" };
  if (existing) return { status: "rejected", reason: "reading_id_conflict" };

  return { status: "rejected", reason: "sequence_conflict" };
}
