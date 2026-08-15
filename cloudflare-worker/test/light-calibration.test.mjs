import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  deriveLightMetrics,
  estimatePpfd,
  lightCalibrationAt,
  publicLightCalibration
} from "../src/metrics/light-calibration.js";

test("applies the configured grow-light PPFD coefficient", () => {
  assert.equal(estimatePpfd(10000), 173.2);
  assert.equal(estimatePpfd(24800), 429.54);
  assert.equal(estimatePpfd(-1), null);
  assert.equal(estimatePpfd(Number.NaN), null);
});

test("selects the calibration only from its effective date", () => {
  assert.equal(lightCalibrationAt("2026-08-15T23:59:59+09:00"), null);
  assert.equal(lightCalibrationAt("2026-08-16T00:00:00+09:00").version, 1);
});

test("derives PPFD only from valid illuminance", () => {
  const reading = {
    measured_at: "2026-08-16T12:00:00+09:00",
    values: { illuminance: 24800 },
    quality: { illuminance: "valid" }
  };
  assert.deepEqual(deriveLightMetrics(reading), {
    estimated_ppfd: {
      value: 429.54,
      unit: "umol/m2/s",
      qualifier: "estimated",
      calibration_profile: "grow-light-01",
      calibration_version: 1
    }
  });
  reading.quality.illuminance = "invalid";
  assert.equal(deriveLightMetrics(reading), null);
});

test("publishes versioned calibration metadata", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/v1/calibrations/light"),
    {},
    {}
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=86400");
  assert.deepEqual(body.calibration, publicLightCalibration());
  assert.equal(body.calibration.version, 1);
  assert.equal(body.calibration.coefficient, 0.01732);
  assert.equal(body.calibration.method, "fixed_lux_coefficient");
});

test("adds estimated PPFD to public illuminance readings without changing the raw value", async () => {
  const database = {
    prepare() {
      return {
        bind() { return this; },
        async all() {
          return { results: [{
            id: 1,
            reading_id: "boot0001:1",
            device_id: "esp32-01",
            site_id: "home-lab",
            zone_id: "tower-01",
            measured_at: "2026-08-16T03:00:00.000Z",
            received_at: "2026-08-16T03:00:02.000Z",
            firmware_version: "8.5.0",
            reset_reason: "power_on",
            metric: "illuminance",
            value: 24800,
            quality: "valid",
            diagnostic: null
          }] };
        }
      };
    }
  };
  const response = await worker.fetch(
    new Request(
      "https://worker.example/v1/readings?date=2026-08-16" +
      "&device_id=esp32-01&metrics=illuminance"
    ),
    { HYDROPONICS_DB: database },
    { waitUntil() {} }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.readings[0].values.illuminance, 24800);
  assert.equal(body.readings[0].derived.estimated_ppfd.value, 429.54);
  assert.equal(body.calibrations.estimated_ppfd.version, 1);
});
