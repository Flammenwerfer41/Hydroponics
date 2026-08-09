import { METRICS } from "../ingestion/contract.js";

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_TIMEZONE = "Asia/Tokyo";
export const METRIC_NAMES = Object.freeze(Object.keys(METRICS));

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const JST_OFFSET = "+09:00";

const QUERY_RULES = Object.freeze({
  latest: Object.freeze({ defaultDays: 1, maxDays: 7, defaultLimit: 1, maxLimit: 1 }),
  raw: Object.freeze({ defaultDays: 1, maxDays: 7, defaultLimit: 720, maxLimit: 1000 }),
  hourly: Object.freeze({ defaultDays: 7, maxDays: 31 }),
  daily: Object.freeze({ defaultDays: 30, maxDays: 366 }),
  export: Object.freeze({ defaultDays: 1, maxDays: 31 })
});

const COMMON_PARAMETERS = new Set([
  "site_id", "zone_id", "device_id", "from", "to", "date", "days", "metrics"
]);

export class HistoryRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "HistoryRequestError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new HistoryRequestError(code, message, status);
}

function parseIdentifier(parameters, name) {
  const value = parameters.get(name);
  if (value === null || value === "") return null;
  if (!IDENTIFIER_PATTERN.test(value)) fail("invalid_filter", `${name} has an invalid format`);
  return value;
}

function parseInteger(parameters, name, minimum, maximum, fallback) {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) fail("invalid_parameter", `${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("invalid_parameter", `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseTimestamp(raw, name) {
  if (raw === null) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    fail("invalid_time_range", `${name} must include a timezone offset`);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) fail("invalid_time_range", `${name} is not a valid timestamp`);
  return new Date(milliseconds);
}

function addJstCalendarDays(date, days) {
  const milliseconds = Date.parse(`${date}T00:00:00${JST_OFFSET}`);
  if (!Number.isFinite(milliseconds)) fail("invalid_time_range", "date is not a valid JST calendar date");
  const shifted = new Date(milliseconds + days * 24 * 60 * 60 * 1000);
  return shifted;
}

function parseRange(parameters, rules, now) {
  const date = parameters.get("date");
  const hasExplicitRange = parameters.has("from") || parameters.has("to");
  if (date !== null && hasExplicitRange) {
    fail("invalid_time_range", "date cannot be combined with from or to");
  }
  if (date !== null && parameters.has("days")) {
    fail("invalid_time_range", "date cannot be combined with days");
  }

  let from;
  let to;
  if (date !== null) {
    if (!DATE_PATTERN.test(date)) fail("invalid_time_range", "date must use YYYY-MM-DD");
    from = addJstCalendarDays(date, 0);
    to = addJstCalendarDays(date, 1);
    const roundTrip = new Date(from.getTime() + 9 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    if (roundTrip !== date) fail("invalid_time_range", "date is not a valid calendar date");
  } else {
    const days = parseInteger(parameters, "days", 1, rules.maxDays, rules.defaultDays);
    to = parseTimestamp(parameters.get("to"), "to") ?? new Date(now);
    from = parseTimestamp(parameters.get("from"), "from") ??
      new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  }

  if (from.getTime() >= to.getTime()) {
    fail("invalid_time_range", "from must be earlier than to");
  }
  const rangeDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > rules.maxDays + 1e-9) {
    fail("range_too_large", `The maximum range is ${rules.maxDays} days`, 422);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseMetrics(parameters) {
  const raw = parameters.get("metrics");
  if (raw === null || raw.trim() === "") return [...METRIC_NAMES];
  const metrics = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (metrics.length === 0 || metrics.some((metric) => !Object.hasOwn(METRICS, metric))) {
    fail("invalid_metrics", "metrics contains an unsupported metric");
  }
  return metrics;
}

export function encodeCursor(measuredAt, id) {
  return btoa(JSON.stringify({ measured_at: measuredAt, id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCursor(value) {
  if (value === null) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const parsed = JSON.parse(atob(padded));
    if (typeof parsed.measured_at !== "string" || !Number.isSafeInteger(parsed.id) || parsed.id < 1) {
      fail("invalid_cursor", "cursor is invalid");
    }
    if (!Number.isFinite(Date.parse(parsed.measured_at))) fail("invalid_cursor", "cursor is invalid");
    return { measuredAt: new Date(parsed.measured_at).toISOString(), id: parsed.id };
  } catch (error) {
    if (error instanceof HistoryRequestError) throw error;
    fail("invalid_cursor", "cursor is invalid");
  }
}

export function parseHistoryQuery(url, kind, now = new Date()) {
  const rules = QUERY_RULES[kind];
  if (!rules) throw new Error(`Unsupported history query kind: ${kind}`);
  const parameters = url.searchParams;
  const allowed = new Set(COMMON_PARAMETERS);
  if (kind === "raw") {
    allowed.add("limit");
    allowed.add("cursor");
  }
  for (const name of parameters.keys()) {
    if (!allowed.has(name)) fail("unknown_parameter", `Unsupported query parameter: ${name}`);
  }

  const query = {
    siteId: parseIdentifier(parameters, "site_id"),
    zoneId: parseIdentifier(parameters, "zone_id"),
    deviceId: parseIdentifier(parameters, "device_id"),
    ...parseRange(parameters, rules, now),
    metrics: parseMetrics(parameters)
  };
  if (kind === "raw") {
    query.limit = parseInteger(parameters, "limit", 1, rules.maxLimit, rules.defaultLimit);
    query.cursor = decodeCursor(parameters.get("cursor"));
  }
  return query;
}

export function publicQuery(query) {
  return {
    site_id: query.siteId,
    zone_id: query.zoneId,
    device_id: query.deviceId,
    from: query.from,
    to: query.to,
    metrics: query.metrics,
    ...(query.limit ? { limit: query.limit } : {})
  };
}
