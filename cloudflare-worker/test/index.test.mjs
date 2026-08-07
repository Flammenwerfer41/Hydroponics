import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWeatherPayload,
  calculateApparentTemperature,
  mapUrlFor,
  observationCondition,
  readJmaField
} from "../src/index.js";

const SAMPLE_MAP = {
  "44132": {
    pressure: [1006.0, 0],
    normalPressure: [1008.7, 0],
    temp: [29.8, 0],
    humidity: [70, 0],
    sun10m: [0, 0],
    sun1h: [0.6, 0],
    precipitation10m: [0, 0],
    precipitation1h: [0, 0],
    windDirection: [7, 0],
    wind: [5.7, 0]
  },
  "44126": {
    precipitation10m: [0, 0],
    precipitation1h: [0, 0]
  }
};

test("accepts only normal-quality JMA fields", () => {
  assert.deepEqual(readJmaField({ temp: [24.5, 0] }, "temp"), { value: 24.5, quality: 0 });
  assert.deepEqual(readJmaField({ temp: [24.5, 1] }, "temp"), { value: null, quality: 1 });
  assert.deepEqual(readJmaField({}, "temp"), { value: null, quality: null });
});

test("uses the JST observation time in the JMA map filename", () => {
  assert.equal(
    mapUrlFor(new Date("2026-08-07T17:40:00+09:00")),
    "https://www.jma.go.jp/bosai/amedas/data/map/20260807174000.json"
  );
});

test("builds a direct-observation payload from Tokyo and Setagaya", () => {
  const result = buildWeatherPayload(
    SAMPLE_MAP,
    "2026-08-07T08:40:00Z",
    new Date("2026-08-07T08:42:00Z")
  );

  assert.equal(result.observed_at, "2026-08-07T17:40:00+09:00");
  assert.equal(result.stations.environment.id, "44132");
  assert.equal(result.stations.precipitation.id, "44126");
  assert.equal(result.current.temperature, 29.8);
  assert.equal(result.current.humidity, 70);
  assert.equal(result.current.precipitation_10m, 0);
  assert.equal(result.current.wind_direction.en, "SSE");
  assert.equal(result.condition.code, "dry");
  assert.equal(result.quality.stale, false);
  assert.equal(result.quality.age_minutes, 2);
});

test("falls back to Tokyo precipitation when Setagaya is unavailable", () => {
  const map = structuredClone(SAMPLE_MAP);
  delete map["44126"];
  map["44132"].precipitation10m = [0.5, 0];
  const result = buildWeatherPayload(map, "2026-08-07T08:40:00Z", new Date("2026-08-07T08:41:00Z"));

  assert.equal(result.stations.precipitation.id, "44132");
  assert.equal(result.current.precipitation_10m, 0.5);
  assert.equal(result.condition.code, "precipitation");
});

test("keeps failed fields null without discarding the observation", () => {
  const map = structuredClone(SAMPLE_MAP);
  map["44132"].humidity = [70, 1];
  const result = buildWeatherPayload(map, "2026-08-07T08:40:00Z", new Date("2026-08-07T08:41:00Z"));

  assert.equal(result.current.temperature, 29.8);
  assert.equal(result.current.humidity, null);
  assert.equal(result.current.apparent_temperature, null);
  assert.equal(result.quality.fields.humidity, 1);
});

test("marks observations older than thirty minutes as stale", () => {
  const result = buildWeatherPayload(
    SAMPLE_MAP,
    "2026-08-07T08:00:00Z",
    new Date("2026-08-07T08:31:00Z")
  );
  assert.equal(result.quality.stale, true);
});

test("classifies only directly observed precipitation and sunshine", () => {
  assert.equal(observationCondition(0.5, 0).code, "precipitation");
  assert.equal(observationCondition(0, 0.1).code, "sunshine");
  assert.equal(observationCondition(0, 0).code, "dry");
  assert.equal(observationCondition(null, null).code, "unknown");
});

test("calculates an apparent temperature from observations", () => {
  const apparent = calculateApparentTemperature(29.8, 70, 5.7);
  assert.equal(Number.isFinite(apparent), true);
});
