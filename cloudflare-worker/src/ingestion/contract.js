export const READING_SCHEMA_VERSION = 1;

export const QUALITY_STATES = Object.freeze([
  "valid",
  "missing",
  "invalid",
  "stale",
  "suspect",
  "calibrating"
]);

export const METRICS = Object.freeze({
  air_temperature: Object.freeze({ unit: "degC", minimum: -40, maximum: 85 }),
  humidity: Object.freeze({ unit: "percent", minimum: 0, maximum: 100 }),
  pressure: Object.freeze({ unit: "hPa", minimum: 300, maximum: 1200 }),
  wifi_rssi: Object.freeze({ unit: "dBm", minimum: -127, maximum: 0 }),
  water_temperature: Object.freeze({ unit: "degC", minimum: -55, maximum: 125 }),
  light_status: Object.freeze({ unit: "state", minimum: 0, maximum: 1, integer: true }),
  light_power: Object.freeze({ unit: "W", minimum: 0, maximum: 5000 }),
  light_uptime: Object.freeze({ unit: "min", minimum: 0, maximum: 1440 })
});

const READING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
const BOOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const FIRMWARE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const EARLIEST_MEASUREMENT_MS = Date.parse("2020-01-01T00:00:00Z");
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

export class ReadingValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ReadingValidationError";
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateIdentifier(name, value, pattern, errors) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${name} has an invalid format`);
  }
}

function normalizeMetricValue(metric, rawValue, requestedQuality, diagnostic, errors) {
  const definition = METRICS[metric];
  let value = rawValue;
  if (metric === "light_status" && typeof value === "boolean") value = value ? 1 : 0;

  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    errors.push(`values.${metric} must be a finite number or null`);
    return null;
  }

  let quality = requestedQuality;
  if (quality === undefined) quality = value === null ? "missing" : "valid";
  if (!QUALITY_STATES.includes(quality)) {
    errors.push(`quality.${metric} is not supported`);
    return null;
  }

  if (value === null && !["missing", "invalid"].includes(quality)) {
    errors.push(`quality.${metric} cannot be ${quality} when the value is null`);
  }
  if (value !== null && definition.integer && !Number.isInteger(value)) {
    quality = "invalid";
  }
  if (value !== null && (value < definition.minimum || value > definition.maximum)) {
    quality = "invalid";
  }
  if (diagnostic !== undefined && (typeof diagnostic !== "string" || diagnostic.length > 160)) {
    errors.push(`diagnostics.${metric} must be a string of at most 160 characters`);
  }

  return {
    metric,
    value,
    unit: definition.unit,
    quality,
    diagnostic: diagnostic ?? null
  };
}

export function normalizeReading(input, now = new Date()) {
  if (!isRecord(input)) throw new ReadingValidationError("Reading must be a JSON object");

  const errors = [];
  if (input.schema_version !== READING_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${READING_SCHEMA_VERSION}`);
  }
  validateIdentifier("reading_id", input.reading_id, READING_ID_PATTERN, errors);
  validateIdentifier("boot_id", input.boot_id, BOOT_ID_PATTERN, errors);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    errors.push("sequence must be a non-negative safe integer");
  }
  validateIdentifier(
    "firmware_version",
    input.firmware_version,
    FIRMWARE_VERSION_PATTERN,
    errors
  );

  const measuredMs = typeof input.measured_at === "string" ? Date.parse(input.measured_at) : NaN;
  if (!Number.isFinite(measuredMs)) {
    errors.push("measured_at must be an ISO 8601 timestamp with an offset");
  } else {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(input.measured_at)) {
      errors.push("measured_at must include a timezone offset");
    }
    if (measuredMs < EARLIEST_MEASUREMENT_MS) errors.push("measured_at is unreasonably old");
    if (measuredMs > now.getTime() + MAX_FUTURE_SKEW_MS) {
      errors.push("measured_at is more than ten minutes in the future");
    }
  }

  if (!isRecord(input.values)) errors.push("values must be a JSON object");
  if (input.quality !== undefined && !isRecord(input.quality)) {
    errors.push("quality must be a JSON object when present");
  }
  if (input.diagnostics !== undefined && !isRecord(input.diagnostics)) {
    errors.push("diagnostics must be a JSON object when present");
  }

  const values = isRecord(input.values) ? input.values : {};
  const quality = isRecord(input.quality) ? input.quality : {};
  const diagnostics = isRecord(input.diagnostics) ? input.diagnostics : {};
  const suppliedMetrics = Object.keys(values);
  if (suppliedMetrics.length === 0) errors.push("values must contain at least one metric");

  for (const field of [...Object.keys(values), ...Object.keys(quality), ...Object.keys(diagnostics)]) {
    if (!Object.hasOwn(METRICS, field)) errors.push(`Unknown metric: ${field}`);
  }

  const normalizedValues = suppliedMetrics
    .filter((metric) => Object.hasOwn(METRICS, metric))
    .map((metric) => normalizeMetricValue(
      metric,
      values[metric],
      quality[metric],
      diagnostics[metric],
      errors
    ))
    .filter(Boolean);

  if (input.reset_reason !== undefined &&
      (typeof input.reset_reason !== "string" || input.reset_reason.length > 80)) {
    errors.push("reset_reason must be a string of at most 80 characters");
  }

  if (errors.length > 0) {
    throw new ReadingValidationError("Reading validation failed", [...new Set(errors)]);
  }

  return {
    schemaVersion: READING_SCHEMA_VERSION,
    readingId: input.reading_id,
    bootId: input.boot_id,
    sequence: input.sequence,
    measuredAt: new Date(measuredMs).toISOString(),
    firmwareVersion: input.firmware_version,
    resetReason: input.reset_reason ?? null,
    values: normalizedValues
  };
}

