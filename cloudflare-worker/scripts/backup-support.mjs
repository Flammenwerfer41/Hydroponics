import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const DATABASE_TABLES = Object.freeze([
  "sites",
  "zones",
  "slots",
  "crops",
  "crop_cycles",
  "plantings",
  "firmware_releases",
  "devices",
  "device_credentials",
  "sensors",
  "sensor_calibrations",
  "actuators",
  "actuator_telemetry",
  "actuator_commands",
  "automation_settings",
  "readings",
  "measurement_values",
  "cultivation_events",
  "journal_entries",
  "journal_days",
  "journal_sections",
  "journal_tags",
  "journal_section_tags",
  "journal_day_values",
  "journal_photos",
  "journal_crop_photos",
  "assets",
  "weather_records",
  "alerts",
  "audit_log"
]);

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function gzipArtifact(buffer) {
  return gzipSync(buffer, { level: 9, mtime: 0 });
}

export function cloudflareAccessHeaders(clientId, clientSecret) {
  const normalizedId = typeof clientId === "string"
    ? clientId.replace(/^\uFEFF/, "").trim()
    : "";
  const normalizedSecret = typeof clientSecret === "string"
    ? clientSecret.replace(/^\uFEFF/, "").trim()
    : "";
  if (!normalizedId || !normalizedSecret) {
    throw new Error(
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required for the protected sensor export"
    );
  }
  return {
    Accept: "application/json",
    "CF-Access-Client-Id": normalizedId,
    "CF-Access-Client-Secret": normalizedSecret
  };
}

export function verifyArtifact(archive, expected) {
  if (!expected || typeof expected !== "object") {
    throw new Error("Backup manifest is missing artifact metadata");
  }
  if (archive.length !== expected.compressed_bytes) {
    throw new Error("Compressed backup size does not match its manifest");
  }
  if (sha256(archive) !== expected.compressed_sha256) {
    throw new Error("Compressed backup checksum does not match its manifest");
  }

  const content = gunzipSync(archive);
  if (content.length !== expected.uncompressed_bytes) {
    throw new Error("Uncompressed backup size does not match its manifest");
  }
  if (sha256(content) !== expected.uncompressed_sha256) {
    throw new Error("Uncompressed backup checksum does not match its manifest");
  }
  return content;
}

export function artifactMetadata(content, archive, key, contentType) {
  return {
    key,
    content_type: contentType,
    storage_content_type: "application/gzip",
    encoding: "gzip",
    uncompressed_bytes: content.length,
    uncompressed_sha256: sha256(content),
    compressed_bytes: archive.length,
    compressed_sha256: sha256(archive)
  };
}

export function jstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function previousJstDate(date = new Date()) {
  const shifted = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  const { year, month, day } = jstDateParts(shifted);
  return `${year}-${month}-${day}`;
}

export function parseWranglerJson(output) {
  const cleaned = String(output).replace(/\u001b\[[0-9;]*m/g, "").trim();
  const starts = [cleaned.indexOf("["), cleaned.indexOf("{")]
    .filter((index) => index >= 0);
  if (!starts.length) throw new Error("Wrangler did not return JSON output");
  const start = Math.min(...starts);
  const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  if (end < start) throw new Error("Wrangler returned incomplete JSON output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function tableCountQuery(tables = DATABASE_TABLES) {
  return tables
    .map((table) => `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM "${table}"`)
    .join("; ");
}

export function normalizeCountRows(payload) {
  const blocks = Array.isArray(payload) ? payload : [payload];
  const rows = blocks.flatMap((block) => block?.results ?? block?.result?.[0]?.results ?? []);
  return Object.fromEntries(rows.map(({ table_name, row_count }) => [
    String(table_name),
    Number(row_count)
  ]));
}

export function compareTableCounts(expected, actual) {
  const mismatches = [];
  for (const table of DATABASE_TABLES) {
    const source = Number(expected?.[table] ?? -1);
    const restored = Number(actual?.[table] ?? -1);
    if (source !== restored) mismatches.push({ table, source, restored });
  }
  return mismatches;
}
