import test from "node:test";
import assert from "node:assert/strict";

import worker, {
  buildForecastPayload,
  buildWeatherPayload,
  calculateApparentTemperature,
  mapUrlFor,
  observationCondition,
  readJmaField
} from "../src/index.js";

const SAMPLE_FORECAST = {
  firstAreaCode: "130010",
  reportDateTime: "2026-08-07T17:00:00+09:00",
  areaTimeSeries: {
    timeDefines: [
      { dateTime: "2026-08-07T18:00:00+09:00", duration: "PT3H" },
      { dateTime: "2026-08-07T21:00:00+09:00", duration: "PT3H" }
    ],
    weather: ["くもり", "晴れ"],
    wind: [
      { direction: "南", speed: 4, range: "10 14" },
      { direction: "南", speed: 2, range: "3 5" }
    ]
  },
  pointTimeSeries: {
    pointNameJP: "東京",
    timeDefines: [
      { dateTime: "2026-08-07T18:00:00+09:00" },
      { dateTime: "2026-08-07T21:00:00+09:00" }
    ],
    temperature: [30, 28],
    maxTemperature: ["", ""],
    minTemperature: ["", ""]
  }
};

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

test("combines Tokyo weather, temperature and wind forecast by timestamp", () => {
  const result = buildForecastPayload(SAMPLE_FORECAST);

  assert.equal(result.area_code, "130010");
  assert.equal(result.published_at, "2026-08-07T17:00:00+09:00");
  assert.equal(result.periods.length, 2);
  assert.deepEqual(result.periods[0], {
    starts_at: "2026-08-07T18:00:00+09:00",
    duration: "PT3H",
    weather: "くもり",
    temperature: 30,
    maximum_temperature: null,
    minimum_temperature: null,
    wind_direction: "南",
    wind_speed: 4,
    wind_range: "10 14"
  });
});

test("delegates non-API requests to Workers Static Assets", async () => {
  let requestedPath = null;
  const response = await worker.fetch(
    new Request("https://worker.example/styles.css"),
    {
      ASSETS: {
        fetch(request) {
          requestedPath = new URL(request.url).pathname;
          return new Response("dashboard asset", {
            headers: { "Content-Type": "text/css" }
          });
        }
      }
    },
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "dashboard asset");
  assert.equal(requestedPath, "/styles.css");
});

test("keeps unknown API routes out of the asset namespace", async () => {
  let assetRequests = 0;
  const response = await worker.fetch(
    new Request("https://worker.example/v1/unknown"),
    {
      ASSETS: {
        fetch() {
          assetRequests += 1;
          return new Response("unexpected");
        }
      }
    },
    {}
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal(assetRequests, 0);
});
