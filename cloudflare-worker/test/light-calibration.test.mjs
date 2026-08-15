import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  deriveLightMetrics,
  estimatePpfd,
  lightCalibrationAt,
  publicLightCalibration
} from "../src/metrics/light-calibration.js";

test("reproduces the manufacturer PPFD reference and example", () => {
  assert.equal(estimatePpfd(29518), 551);
  assert.equal(estimatePpfd(24800), 462.93);
  assert.equal(estimatePpfd(-1), null);
  assert.equal(estimatePpfd(Number.NaN), null);
});

test("selects the calibration only from its effective date", () => {
  assert.equal(lightCalibrationAt("2026-08-14T23:59:59+09:00"), null);
  assert.equal(lightCalibrationAt("2026-08-15T00:00:00+09:00").version, 1);
});

test("derives PPFD only from valid illuminance", () => {
  const reading = {
    measured_at: "2026-08-15T12:00:00+09:00",
    values: { illuminance: 24800 },
    quality: { illuminance: "valid" }
  };
  assert.deepEqual(deriveLightMetrics(reading), {
    estimated_ppfd: {
      value: 462.93,
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
  assert.equal(body.calibration.reference.illuminance_lux, 29518);
  assert.equal(body.calibration.reference.ppfd_umol_m2_s, 551);
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
            measured_at: "2026-08-15T03:00:00.000Z",
            received_at: "2026-08-15T03:00:02.000Z",
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
      "https://worker.example/v1/readings?date=2026-08-15" +
      "&device_id=esp32-01&metrics=illuminance"
    ),
    { HYDROPONICS_DB: database },
    { waitUntil() {} }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.readings[0].values.illuminance, 24800);
  assert.equal(body.readings[0].derived.estimated_ppfd.value, 462.93);
  assert.equal(body.calibrations.estimated_ppfd.version, 1);
});
