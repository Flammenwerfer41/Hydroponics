import test from "node:test";
import assert from "node:assert/strict";
import {
  observationTimesToCollect,
  refreshStoredObservation
} from "../src/weather/store.js";

test("collects only missing ten-minute JMA slots", () => {
  assert.deepEqual(
    observationTimesToCollect("2026-08-12T03:00:00Z", "2026-08-12T03:30:00Z"),
    [
      "2026-08-12T03:10:00.000Z",
      "2026-08-12T03:20:00.000Z",
      "2026-08-12T03:30:00.000Z"
    ]
  );
  assert.deepEqual(
    observationTimesToCollect("2026-08-12T03:30:00Z", "2026-08-12T03:30:00Z"),
    []
  );
  assert.deepEqual(observationTimesToCollect(null, "2026-08-12T03:30:00Z"), [
    "2026-08-12T03:30:00.000Z"
  ]);
});

test("bounds JMA catch-up to the most recent two hours", () => {
  const result = observationTimesToCollect(
    "2026-08-10T00:00:00Z",
    "2026-08-12T03:30:00Z"
  );
  assert.equal(result.length, 12);
  assert.equal(result[0], "2026-08-12T01:40:00.000Z");
  assert.equal(result.at(-1), "2026-08-12T03:30:00.000Z");
});

test("recalculates stored JMA age without changing the observed values", () => {
  const payload = refreshStoredObservation({
    observed_at: "2026-08-12T12:00:00+09:00",
    current: { temperature: 30.1 },
    quality: { stale: false, age_minutes: 1, stale_after_minutes: 30 }
  }, new Date("2026-08-12T03:35:00Z"));
  assert.equal(payload.current.temperature, 30.1);
  assert.equal(payload.quality.age_minutes, 35);
  assert.equal(payload.quality.stale, true);
  assert.equal(payload.quality.storage, "D1");
  assert.equal(payload.generated_at, "2026-08-12T12:35:00+09:00");
});
