import { METRICS } from "../ingestion/contract.js";
import { encodeCursor } from "./contract.js";

const VALID_QUALITY = "valid";
const EXPORT_LIMIT = 25_000;

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function metricPlaceholders(metrics) {
  return metrics.map(() => "?").join(", ");
}

function buildFilters(query, { includeCursor = false } = {}) {
  const clauses = ["r.measured_at >= ?", "r.measured_at < ?"];
  const bindings = [query.from, query.to];
  if (query.siteId) {
    clauses.push("d.site_id = ?");
    bindings.push(query.siteId);
  }
  if (query.zoneId) {
    clauses.push("d.zone_id = ?");
    bindings.push(query.zoneId);
  }
  if (query.deviceId) {
    clauses.push("r.device_id = ?");
    bindings.push(query.deviceId);
  }
  if (includeCursor && query.cursor) {
    clauses.push("(r.measured_at < ? OR (r.measured_at = ? AND r.id < ?))");
    bindings.push(query.cursor.measuredAt, query.cursor.measuredAt, query.cursor.id);
  }
  return { sql: clauses.join(" AND "), bindings };
}

function emptyReading(row) {
  return {
    id: row.id,
    reading_id: row.reading_id,
    device_id: row.device_id,
    site_id: row.site_id,
    zone_id: row.zone_id,
    measured_at: row.measured_at,
    received_at: row.received_at,
    firmware_version: row.firmware_version,
    reset_reason: row.reset_reason,
    values: {},
    quality: {},
    diagnostics: {}
  };
}

export function groupReadingRows(rows, limit = Infinity) {
  const readings = [];
  const byId = new Map();
  for (const row of rows) {
    let reading = byId.get(row.id);
    if (!reading) {
      reading = emptyReading(row);
      byId.set(row.id, reading);
      readings.push(reading);
    }
    if (row.metric !== null && row.metric !== undefined) {
      reading.values[row.metric] = row.value ?? null;
      reading.quality[row.metric] = row.quality ?? "missing";
      if (row.diagnostic !== null && row.diagnostic !== undefined) {
        reading.diagnostics[row.metric] = row.diagnostic;
      }
    }
  }

  const hasMore = readings.length > limit;
  const selected = readings.slice(0, limit);
  const last = selected.at(-1);
  return {
    readings: selected.map(({ id, ...reading }) => reading),
    nextCursor: hasMore && last ? encodeCursor(last.measured_at, last.id) : null
  };
}

export async function queryRawReadings(database, query) {
  const filters = buildFilters(query, { includeCursor: true });
  const bindings = [...filters.bindings, query.limit + 1, ...query.metrics];
  const result = await database.prepare(`
    WITH selected AS (
      SELECT r.id, r.reading_id, r.device_id, d.site_id, d.zone_id,
        r.measured_at, r.received_at, r.firmware_version, r.reset_reason
      FROM readings r
      JOIN devices d ON d.id = r.device_id
      WHERE ${filters.sql}
      ORDER BY r.measured_at DESC, r.id DESC
      LIMIT ?
    )
    SELECT s.*, mv.metric, mv.value, mv.quality, mv.diagnostic
    FROM selected s
    LEFT JOIN measurement_values mv
      ON mv.reading_pk = s.id AND mv.metric IN (${metricPlaceholders(query.metrics)})
    ORDER BY s.measured_at DESC, s.id DESC, mv.metric ASC
  `).bind(...bindings).all();
  return groupReadingRows(resultRows(result), query.limit);
}

export async function queryLatestReading(database, query) {
  const raw = await queryRawReadings(database, { ...query, limit: 1, cursor: null });
  return raw.readings[0] ?? null;
}

function bucketExpression(granularity) {
  if (granularity === "hourly") {
    return "strftime('%Y-%m-%dT%H:00:00+09:00', r.measured_at, '+9 hours')";
  }
  if (granularity === "daily") {
    return "strftime('%Y-%m-%d', r.measured_at, '+9 hours')";
  }
  throw new Error(`Unsupported granularity: ${granularity}`);
}

function bucketEnd(start, granularity) {
  if (granularity === "hourly") {
    return new Date(Date.parse(start) + 10 * 60 * 60 * 1000)
      .toISOString().replace(".000Z", "+09:00");
  }
  const milliseconds = Date.parse(`${start}T00:00:00+09:00`) + 24 * 60 * 60 * 1000;
  return new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function groupAggregateRows(rows, granularity) {
  const buckets = [];
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.bucket_start}|${row.device_id}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        start: row.bucket_start,
        end: bucketEnd(row.bucket_start, granularity),
        device_id: row.device_id,
        site_id: row.site_id,
        zone_id: row.zone_id,
        metrics: {}
      };
      byKey.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.metrics[row.metric] = {
      unit: row.unit,
      samples: Number(row.samples ?? 0),
      valid_samples: Number(row.valid_samples ?? 0),
      missing_samples: Number(row.missing_samples ?? 0),
      minimum: row.minimum ?? null,
      maximum: row.maximum ?? null,
      mean: row.mean ?? null
    };
  }
  return buckets;
}

export async function queryAggregates(database, query, granularity) {
  const filters = buildFilters(query);
  const bucket = bucketExpression(granularity);
  const result = await database.prepare(`
    SELECT ${bucket} AS bucket_start,
      r.device_id, d.site_id, d.zone_id, mv.metric, mv.unit,
      COUNT(*) AS samples,
      SUM(CASE WHEN mv.quality = '${VALID_QUALITY}' AND mv.value IS NOT NULL THEN 1 ELSE 0 END)
        AS valid_samples,
      SUM(CASE WHEN mv.value IS NULL THEN 1 ELSE 0 END) AS missing_samples,
      MIN(CASE WHEN mv.quality = '${VALID_QUALITY}' THEN mv.value END) AS minimum,
      MAX(CASE WHEN mv.quality = '${VALID_QUALITY}' THEN mv.value END) AS maximum,
      AVG(CASE WHEN mv.quality = '${VALID_QUALITY}' THEN mv.value END) AS mean
    FROM readings r
    JOIN devices d ON d.id = r.device_id
    JOIN measurement_values mv ON mv.reading_pk = r.id
    WHERE ${filters.sql}
      AND mv.metric IN (${metricPlaceholders(query.metrics)})
    GROUP BY bucket_start, r.device_id, d.site_id, d.zone_id, mv.metric, mv.unit
    ORDER BY bucket_start ASC, r.device_id ASC, mv.metric ASC
  `).bind(...filters.bindings, ...query.metrics).all();
  return groupAggregateRows(resultRows(result), granularity);
}

function exportMetricColumns(metrics) {
  return metrics.flatMap((metric) => {
    if (!Object.hasOwn(METRICS, metric)) throw new Error(`Unsupported export metric: ${metric}`);
    return [
      `MAX(CASE WHEN mv.metric = '${metric}' THEN mv.value END) AS ${metric}`,
      `MAX(CASE WHEN mv.metric = '${metric}' THEN mv.quality END) AS ${metric}_quality`,
      `MAX(CASE WHEN mv.metric = '${metric}' THEN mv.diagnostic END) AS ${metric}_diagnostic`
    ];
  }).join(",\n      ");
}

export async function queryExportRows(database, query) {
  const filters = buildFilters(query);
  const result = await database.prepare(`
    SELECT r.id, r.reading_id, r.device_id, d.site_id, d.zone_id,
      r.measured_at, r.received_at, r.firmware_version, r.reset_reason,
      ${exportMetricColumns(query.metrics)}
    FROM readings r
    JOIN devices d ON d.id = r.device_id
    LEFT JOIN measurement_values mv
      ON mv.reading_pk = r.id AND mv.metric IN (${metricPlaceholders(query.metrics)})
    WHERE ${filters.sql}
    GROUP BY r.id
    ORDER BY r.measured_at ASC, r.id ASC
    LIMIT ?
  `).bind(...query.metrics, ...filters.bindings, EXPORT_LIMIT + 1).all();
  const rows = resultRows(result);
  if (rows.length > EXPORT_LIMIT) {
    const error = new Error("Export contains too many readings; request a shorter range");
    error.code = "export_too_large";
    error.status = 422;
    throw error;
  }
  return rows;
}

export function exportRowsToReadings(rows, metrics) {
  return rows.map((row) => {
    const reading = emptyReading(row);
    for (const metric of metrics) {
      reading.values[metric] = row[metric] ?? null;
      reading.quality[metric] = row[`${metric}_quality`] ?? "missing";
      const diagnostic = row[`${metric}_diagnostic`];
      if (diagnostic !== null && diagnostic !== undefined) {
        reading.diagnostics[metric] = diagnostic;
      }
    }
    const { id, ...publicReading } = reading;
    return publicReading;
  });
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportRowsToCsv(rows, metrics) {
  const metadata = [
    "reading_id", "device_id", "site_id", "zone_id", "measured_at", "received_at",
    "firmware_version", "reset_reason"
  ];
  const metricColumns = metrics.flatMap((metric) => [
    metric, `${metric}_quality`, `${metric}_diagnostic`
  ]);
  const columns = [...metadata, ...metricColumns];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
