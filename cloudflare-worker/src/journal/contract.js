const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITIES = new Set(["private", "public"]);
const LIQUID_TYPES = new Set(["water", "prepared_solution", "concentrate", "other"]);

export class JournalRequestError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "JournalRequestError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 422) {
  throw new JournalRequestError(code, message, status);
}

function text(value, name, maximum, required = false) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") fail("invalid_journal", `${name} must be text`);
  const normalized = value.trim();
  if (required && !normalized) fail("invalid_journal", `${name} is required`);
  if (normalized.length > maximum) fail("invalid_journal", `${name} is too long`);
  return normalized;
}

function finite(value, name, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail("invalid_measurement", `${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function validDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function identifier(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("invalid_journal", `${name} has an invalid format`);
  }
  return value;
}

function uniqueIdentifiers(values, name) {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values) || values.length > 20) fail("invalid_journal", `${name} must be an array`);
  return [...new Set(values.map((value) => identifier(value, name)))];
}

export function parseJournalInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("invalid_journal", "Journal body must be an object", 400);
  }
  if (!validDate(body.journal_date)) fail("invalid_journal", "journal_date must be a real YYYY-MM-DD date");
  const commonNote = text(body.common_note, "common_note", 20_000);
  const visibility = body.visibility ?? "private";
  if (!VISIBILITIES.has(visibility)) fail("invalid_journal", "visibility must be private or public");

  const rawSections = body.sections ?? [];
  if (!Array.isArray(rawSections) || rawSections.length > 30) {
    fail("invalid_journal", "sections must be an array with at most 30 items");
  }
  const seenCrops = new Set();
  const sections = rawSections.map((section, index) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      fail("invalid_journal", "Every crop section must be an object");
    }
    const cropId = identifier(section.crop_id, "crop_id");
    if (seenCrops.has(cropId)) fail("invalid_journal", "A crop can appear only once per day");
    seenCrops.add(cropId);
    return {
      crop_id: cropId,
      title: text(section.title, "section title", 160),
      body: text(section.body, "section body", 20_000, true),
      tag_ids: uniqueIdentifiers(section.tag_ids, "tag_id"),
      sort_order: index
    };
  });

  const rawMeasurements = body.measurements ?? {};
  if (!rawMeasurements || typeof rawMeasurements !== "object" || Array.isArray(rawMeasurements)) {
    fail("invalid_measurement", "measurements must be an object");
  }
  const measurements = {
    solution_ph: finite(rawMeasurements.solution_ph, "pH", 0, 14),
    electrical_conductivity: finite(rawMeasurements.electrical_conductivity, "EC", 0, 20),
    solution_added_volume: finite(rawMeasurements.solution_added_volume, "top-up volume", 0, 1000),
    solution_added_liquid_type: rawMeasurements.solution_added_liquid_type ?? null
  };
  if (measurements.solution_added_volume !== null) {
    if (!LIQUID_TYPES.has(measurements.solution_added_liquid_type)) {
      fail("invalid_measurement", "A valid liquid type is required with top-up volume");
    }
  } else {
    measurements.solution_added_liquid_type = null;
  }

  const hasMeasurement = Object.entries(measurements)
    .some(([name, value]) => name !== "solution_added_liquid_type" && value !== null);
  if (!commonNote && sections.length === 0 && !hasMeasurement) {
    fail("empty_journal", "Add a common note, crop section or measurement");
  }
  let revision = null;
  if (body.revision !== undefined && body.revision !== null) {
    revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      fail("invalid_journal", "revision must be a positive integer");
    }
  }
  return {
    journal_date: body.journal_date,
    common_note: commonNote,
    visibility,
    revision,
    measurements,
    sections
  };
}

function integer(parameters, name, minimum, maximum, fallback = null) {
  const raw = parameters.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) fail("invalid_filter", `${name} must be an integer`, 400);
  const value = Number(raw);
  if (value < minimum || value > maximum) fail("invalid_filter", `${name} is out of range`, 400);
  return value;
}

export function parseJournalListQuery(url, now = new Date()) {
  const parameters = url.searchParams;
  const allowed = new Set(["year", "month", "day", "crop_id", "tag_id", "limit"]);
  for (const name of parameters.keys()) {
    if (!allowed.has(name)) fail("invalid_filter", `Unsupported filter: ${name}`, 400);
  }
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = integer(parameters, "year", 2020, 2100, jst.getUTCFullYear());
  const month = integer(parameters, "month", 1, 12, jst.getUTCMonth() + 1);
  const day = integer(parameters, "day", 1, 31);
  if (day !== null && !validDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)) {
    fail("invalid_filter", "day is not valid for the selected month", 400);
  }
  return {
    year,
    month,
    day,
    cropId: parameters.has("crop_id") ? identifier(parameters.get("crop_id"), "crop_id") : null,
    tagId: parameters.has("tag_id") ? identifier(parameters.get("tag_id"), "tag_id") : null,
    limit: integer(parameters, "limit", 1, 200, 100)
  };
}

export const JOURNAL_UNITS = Object.freeze({
  solution_ph: "pH",
  electrical_conductivity: "mS/cm",
  solution_added_volume: "L"
});
