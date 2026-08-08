import test from "node:test";
import assert from "node:assert/strict";

import {
  ReadingValidationError,
  normalizeReading
} from "../src/ingestion/contract.js";

const NOW = new Date("2026-08-09T01:00:00Z");

function sampleReading() {
  return {
    schema_version: 1,
    reading_id: "boot0001:42",
    boot_id: "boot0001",
    sequence: 42,
    measured_at: "2026-08-09T09:59:00+09:00",
    firmware_version: "8.1.0",
    values: {
      air_temperature: 25.3,
      humidity: 61.2,
      pressure: 1007.8,
      wifi_rssi: -57,
      water_temperature: 24.6,
      light_status: true,
      light_power: 73.7,
      light_uptime: 180
    },
    quality: {}
  };
}

test("normalizes all current metrics and their units", () => {
  const result = normalizeReading(sampleReading(), NOW);

  assert.equal(result.readingId, "boot0001:42");
  assert.equal(result.measuredAt, "2026-08-09T00:59:00.000Z");
  assert.equal(result.values.length, 8);
  assert.deepEqual(
    result.values.find(({ metric }) => metric === "light_status"),
    { metric: "light_status", value: 1, unit: "state", quality: "valid", diagnostic: null }
  );
});

test("keeps valid fields when another sensor is missing", () => {
  const input = sampleReading();
  input.values.humidity = null;
  input.quality.humidity = "missing";
  input.diagnostics = { humidity: "bme280_read_failed" };

  const result = normalizeReading(input, NOW);
  assert.equal(result.values.find(({ metric }) => metric === "air_temperature").quality, "valid");
  assert.deepEqual(
    result.values.find(({ metric }) => metric === "humidity"),
    {
      metric: "humidity",
      value: null,
      unit: "percent",
      quality: "missing",
      diagnostic: "bme280_read_failed"
    }
  );
});

test("marks an out-of-range field invalid without rejecting the reading", () => {
  const input = sampleReading();
  input.values.humidity = 140;

  const result = normalizeReading(input, NOW);
  assert.equal(result.values.find(({ metric }) => metric === "humidity").value, 140);
  assert.equal(result.values.find(({ metric }) => metric === "humidity").quality, "invalid");
});

test("accepts delayed replay data", () => {
  const input = sampleReading();
  input.measured_at = "2026-07-27T12:00:00+09:00";
  assert.doesNotThrow(() => normalizeReading(input, NOW));
});

test("rejects malformed identity and unknown metrics deterministically", () => {
  const input = sampleReading();
  input.reading_id = "short";
  input.values.ph = 6.2;

  assert.throws(
    () => normalizeReading(input, NOW),
    (error) => error instanceof ReadingValidationError &&
      error.details.includes("reading_id has an invalid format") &&
      error.details.includes("Unknown metric: ph")
  );
});

test("requires timestamps to carry an explicit timezone", () => {
  const input = sampleReading();
  input.measured_at = "2026-08-09T09:59:00";

  assert.throws(
    () => normalizeReading(input, NOW),
    (error) => error.details.includes("measured_at must include a timezone offset")
  );
});
