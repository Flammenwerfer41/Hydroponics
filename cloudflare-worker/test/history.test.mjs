import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  HistoryRequestError,
  decodeCursor,
  encodeCursor,
  parseHistoryQuery
} from "../src/history/contract.js";
import {
  exportRowsToCsv,
  groupAggregateRows,
  groupReadingRows
} from "../src/history/query.js";

const NOW = new Date("2026-08-09T04:30:00Z");

const RAW_ROWS = [
  {
    id: 2,
    reading_id: "boot0001:2",
    device_id: "esp32-01",
    site_id: "home-lab",
    zone_id: "tower-01",
    measured_at: "2026-08-09T04:20:00.000Z",
    received_at: "2026-08-09T04:20:02.000Z",
    firmware_version: "8.2.5",
    reset_reason: "power_on",
    metric: "air_temperature",
    value: 26.5,
    quality: "valid",
    diagnostic: null
  },
  {
    id: 2,
    reading_id: "boot0001:2",
    device_id: "esp32-01",
    site_id: "home-lab",
    zone_id: "tower-01",
    measured_at: "2026-08-09T04:20:00.000Z",
    received_at: "2026-08-09T04:20:02.000Z",
    firmware_version: "8.2.5",
    reset_reason: "power_on",
    metric: "humidity",
    value: null,
    quality: "missing",
    diagnostic: "bme280_read_failed"
  },
  {
    id: 1,
    reading_id: "boot0001:1",
    device_id: "esp32-01",
    site_id: "home-lab",
    zone_id: "tower-01",
    measured_at: "2026-08-09T04:18:00.000Z",
    received_at: "2026-08-09T04:18:02.000Z",
    firmware_version: "8.2.5",
    reset_reason: "power_on",
    metric: "air_temperature",
    value: 26.4,
    quality: "valid",
    diagnostic: null
  }
];

const AGGREGATE_ROWS = [{
  bucket_start: "2026-08-09T13:00:00+09:00",
  device_id: "esp32-01",
  site_id: "home-lab",
  zone_id: "tower-01",
  metric: "air_temperature",
  unit: "degC",
  samples: 2,
  valid_samples: 2,
  missing_samples: 0,
  minimum: 26.4,
  maximum: 26.5,
  mean: 26.45
}];

const EXPORT_ROWS = [{
  id: 1,
  reading_id: "boot0001:1",
  device_id: "esp32-01",
  site_id: "home-lab",
  zone_id: "tower-01",
  measured_at: "2026-08-09T04:18:00.000Z",
  received_at: "2026-08-09T04:18:02.000Z",
  firmware_version: "8.2.5",
  reset_reason: "power_on",
  air_temperature: 26.4,
  air_temperature_quality: "valid",
  air_temperature_diagnostic: null,
  humidity: null,
  humidity_quality: "missing",
  humidity_diagnostic: "sensor, retry"
}];

class FakeStatement {
  constructor(sql) {
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  async all() {
    if (this.sql.includes("WITH selected AS")) return { success: true, results: RAW_ROWS };
    if (this.sql.includes("AS bucket_start")) return { success: true, results: AGGREGATE_ROWS };
    if (this.sql.includes("GROUP BY r.id")) return { success: true, results: EXPORT_ROWS };
    throw new Error(`Unexpected history statement: ${this.sql}`);
  }
}

class FakeD1 {
  prepare(sql) {
    return new FakeStatement(sql);
  }
}

const context = { waitUntil(promise) { return promise; } };

test("maps a JST calendar date to exact UTC boundaries", () => {
  const query = parseHistoryQuery(
    new URL("https://worker.example/v1/readings?date=2026-08-09"),
    "raw",
    NOW
  );
  assert.equal(query.from, "2026-08-08T15:00:00.000Z");
  assert.equal(query.to, "2026-08-09T15:00:00.000Z");
  assert.equal(query.limit, 720);
});

test("rejects oversized raw ranges and unknown parameters", () => {
  assert.throws(
    () => parseHistoryQuery(
      new URL("https://worker.example/v1/readings?days=8"),
      "raw",
      NOW
    ),
    (error) => error instanceof HistoryRequestError && error.code === "invalid_parameter"
  );
  assert.throws(
    () => parseHistoryQuery(
      new URL("https://worker.example/v1/readings?secret=true"),
      "raw",
      NOW
    ),
    (error) => error instanceof HistoryRequestError && error.code === "unknown_parameter"
  );
});

test("round-trips opaque measured-time cursors", () => {
  const cursor = encodeCursor("2026-08-09T04:20:00.000Z", 42);
  assert.deepEqual(decodeCursor(cursor), {
    measuredAt: "2026-08-09T04:20:00.000Z",
    id: 42
  });
});

test("groups partial measurement rows without discarding missing fields", () => {
  const result = groupReadingRows(RAW_ROWS, 1);
  assert.equal(result.readings.length, 1);
  assert.equal(result.readings[0].values.air_temperature, 26.5);
  assert.equal(result.readings[0].values.humidity, null);
  assert.equal(result.readings[0].quality.humidity, "missing");
  assert.equal(result.readings[0].diagnostics.humidity, "bme280_read_failed");
  assert.equal(typeof result.nextCursor, "string");
});

test("groups hourly valid-only statistics with JST bucket boundaries", () => {
  const buckets = groupAggregateRows(AGGREGATE_ROWS, "hourly");
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].start, "2026-08-09T13:00:00+09:00");
  assert.equal(buckets[0].end, "2026-08-09T14:00:00+09:00");
  assert.equal(buckets[0].metrics.air_temperature.valid_samples, 2);
  assert.equal(buckets[0].metrics.air_temperature.mean, 26.45);
});

test("escapes CSV diagnostics and preserves UTF-8 BOM", () => {
  const csv = exportRowsToCsv(EXPORT_ROWS, ["air_temperature", "humidity"]);
  assert.equal(csv.startsWith("\uFEFFreading_id"), true);
  assert.match(csv, /"sensor, retry"/);
});

test("serves latest, aggregate and CSV history routes through the Worker", async () => {
  const environment = { HYDROPONICS_DB: new FakeD1() };
  const latest = await worker.fetch(new Request(
    "https://worker.example/v1/readings/latest?date=2026-08-09&metrics=air_temperature,humidity"
  ), environment, context);
  const latestBody = await latest.json();
  assert.equal(latest.status, 200);
  assert.equal(latestBody.reading.reading_id, "boot0001:2");
  assert.equal(latest.headers.get("X-Data-Cache"), "BYPASS");

  const hourly = await worker.fetch(new Request(
    "https://worker.example/v1/history/hourly?date=2026-08-09&metrics=air_temperature"
  ), environment, context);
  assert.equal((await hourly.json()).buckets[0].start, "2026-08-09T13:00:00+09:00");

  const csv = await worker.fetch(new Request(
    "https://worker.example/v1/export.csv?date=2026-08-09&metrics=air_temperature,humidity"
  ), environment, context);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("Content-Disposition"), /hydroponics-2026-08-09-2026-08-09\.csv/);
  assert.match(await csv.text(), /air_temperature_quality/);
});

test("keeps shared readings CORS available to both uploads and public reads", async () => {
  const response = await worker.fetch(new Request("https://worker.example/v1/readings", {
    method: "OPTIONS"
  }), {}, context);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type");
});
