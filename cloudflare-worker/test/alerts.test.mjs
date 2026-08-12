import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceState,
  calculateVpd,
  classifyThreshold,
  countMetricStreaks
} from "../src/alerts/engine.js";

const HIGH_VPD = {
  direction: "high",
  warning_enter: 2.5,
  warning_exit: 2.3,
  critical_enter: 3.0,
  critical_exit: 2.7
};

test("calculates VPD from air temperature and relative humidity", () => {
  assert.equal(calculateVpd(26.4, 42.3), 1.99);
});

test("uses hysteresis while classifying high VPD", () => {
  assert.equal(classifyThreshold(HIGH_VPD, 2.6, "normal"), "warning");
  assert.equal(classifyThreshold(HIGH_VPD, 2.4, "warning"), "warning");
  assert.equal(classifyThreshold(HIGH_VPD, 3.1, "warning"), "critical");
  assert.equal(classifyThreshold(HIGH_VPD, 2.8, "critical"), "critical");
  assert.equal(classifyThreshold(HIGH_VPD, 2.6, "critical"), "warning");
  assert.equal(classifyThreshold(HIGH_VPD, 2.2, "warning"), "normal");
});

test("opens and escalates only after sustained durations", () => {
  const start = new Date("2026-08-12T00:00:00Z");
  const pending = advanceState({ state: "normal" }, "warning", start, { warning: 1800 });
  assert.equal(pending.state, "normal");
  assert.equal(pending.pendingState, "warning");
  const opened = advanceState(pending, "warning", new Date(start.getTime() + 1800_000), { warning: 1800 });
  assert.equal(opened.state, "warning");
  assert.equal(opened.event, "opened");
  const criticalPending = advanceState(opened, "critical", new Date(start.getTime() + 1801_000), { critical: 900 });
  const critical = advanceState(criticalPending, "critical", new Date(start.getTime() + 2701_000), { critical: 900 });
  assert.equal(critical.event, "escalated");
  assert.equal(critical.state, "critical");
});

test("does not repeat an event while the same alert state continues", () => {
  const stable = advanceState({ state: "warning" }, "warning", new Date(), { warning: 0 });
  assert.equal(stable.changed, false);
  assert.equal(stable.event, null);
});

test("counts consecutive missing and valid sensor samples", () => {
  const missing = { values: { humidity: { value: null, quality: "missing" } } };
  const valid = { values: { humidity: { value: 52, quality: "valid" } } };
  assert.deepEqual(countMetricStreaks([missing, missing, missing, valid], "humidity"), { missing: 3, valid: 0 });
  assert.deepEqual(countMetricStreaks([valid, valid, missing], "humidity"), { missing: 0, valid: 2 });
});
