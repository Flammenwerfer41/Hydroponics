import test from "node:test";
import assert from "node:assert/strict";

import { nextTransition, scheduledPower } from "../src/control/service.js";

const SCHEDULE = Object.freeze({
  enabled: 1,
  on_minute: 7 * 60,
  off_minute: 21 * 60,
  override_state: null,
  override_until: null
});

test("evaluates the grow-light schedule in JST", () => {
  assert.equal(scheduledPower(SCHEDULE, new Date("2026-08-08T21:59:00Z")), "off");
  assert.equal(scheduledPower(SCHEDULE, new Date("2026-08-08T22:00:00Z")), "on");
  assert.equal(scheduledPower(SCHEDULE, new Date("2026-08-09T11:59:00Z")), "on");
  assert.equal(scheduledPower(SCHEDULE, new Date("2026-08-09T12:00:00Z")), "off");
});

test("honors a manual override only until its expiry", () => {
  const schedule = {
    ...SCHEDULE,
    override_state: "off",
    override_until: "2026-08-09T12:00:00.000Z"
  };
  assert.equal(scheduledPower(schedule, new Date("2026-08-09T02:00:00Z")), "off");
  assert.equal(scheduledPower(schedule, new Date("2026-08-09T12:00:00Z")), "off");
});

test("finds the next daily schedule boundary", () => {
  assert.equal(
    nextTransition(SCHEDULE, new Date("2026-08-09T02:30:20Z")),
    "2026-08-09T12:00:00.000Z"
  );
  assert.equal(
    nextTransition(SCHEDULE, new Date("2026-08-09T13:00:20Z")),
    "2026-08-09T22:00:00.000Z"
  );
});
