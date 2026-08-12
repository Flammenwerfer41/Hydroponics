import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateDerivedMetrics,
  historyDomain,
  mergeTimeSeries,
  niceBounds,
  parseRawHistory
} from "../../docs/dashboard/data.js";

test("calculates dashboard derived metrics without DOM state", () => {
  const result = calculateDerivedMetrics(26.4, 42.3);
  assert.equal(result.vpd.toFixed(2), "1.99");
  assert.equal(Number.isFinite(result.dewPoint), true);
  assert.equal(calculateDerivedMetrics(26.4, null), null);
});

test("keeps the day comparison domain fixed to a JST calendar day", () => {
  const domain = historyDomain("day", Date.parse("2026-08-12T14:00:00+09:00"));
  assert.equal(new Date(domain.todayStart).toISOString(), "2026-08-11T15:00:00.000Z");
  assert.equal(domain.end - domain.start, 24 * 60 * 60 * 1000);
  assert.equal(domain.todayStart - domain.previousStart, 24 * 60 * 60 * 1000);
});

test("parses partial sensor history and merges overlapping updates", () => {
  const parsed = parseRawHistory([{
    measured_at: "2026-08-12T05:30:00Z",
    values: { air_temperature: 26.4, humidity: null }
  }]);
  assert.equal(parsed[0].temperature, 26.4);
  assert.equal(parsed[0].humidity, null);
  const merged = mergeTimeSeries(
    [{ time: 1, value: "old" }],
    [{ time: 1, value: "new" }, { time: 2, value: "next" }],
    1,
    2
  );
  assert.deepEqual(merged, [{ time: 1, value: "new" }, { time: 2, value: "next" }]);
});

test("keeps adaptive humidity bounds inside physical limits", () => {
  assert.deepEqual(
    niceBounds([1, 2], { field: "humidity", minimumSpan: 20, step: 5 }),
    [0, 15]
  );
});
