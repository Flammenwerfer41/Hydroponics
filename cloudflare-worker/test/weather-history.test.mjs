import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReadings, segments, extent, loadHistory, SERIES, BATTERY_PERCENT } from "../../docs/weather/history-data.mjs";
import { renderHistory } from "../../docs/weather/history.mjs";
import { staleMilliseconds, scheduleLabel } from '../../docs/weather/schedule.mjs';

test('60-minute emergency observations are not treated as 20-minute gaps or stale data', () => {
  const station_schedule = {normal_interval_seconds:300,applied_interval_seconds:3600,revision:1,reason:'emergency_voltage'};
  const start = Date.parse('2026-11-17T00:00:00Z');
  const rows = [0,60,120,250].map(minute => ({measured_at:new Date(start+minute*60000).toISOString(),station_schedule,
    values:{battery_voltage:3.3},quality:{battery_voltage:'valid'}}));
  assert.deepEqual(segments(normalizeReadings(rows),'battery_voltage').map(s=>s.length),[3,1]);
  assert.equal(staleMilliseconds(station_schedule),125*60000);
  assert.match(scheduleLabel(station_schedule),/60분.*비상/);
  assert.equal(staleMilliseconds(null),35*60000);
});

const now = Date.parse("2026-11-15T01:10:00Z");
const row = (time, values = { battery_voltage: 3.8 }) => ({ measured_at: new Date(time).toISOString(), values,
  quality: Object.fromEntries(Object.keys(values).map(key => [key, "valid"])) });
const reply = (readings, next_cursor = null) => ({ ok: true, json: async () => ({ readings, page: { next_cursor } }) });

test("history keeps partial readings, rejects invalid values and derives battery estimate", () => {
  const data = normalizeReadings([row(now, { battery_voltage: 3.8, humidity: null, pressure: Infinity, air_temperature: 0 })]);
  assert.equal(data[0].values.battery_percent, 67);
  assert.equal(data[0].values.humidity, null);
  assert.equal(data[0].values.pressure, null);
  assert.equal(data[0].values.air_temperature, 0);
  assert.equal(normalizeReadings([{...row(now), quality: {battery_voltage: "invalid"}}])[0].values.battery_percent, null);
});
test("history sorts, deduplicates timestamps and drops invalid timestamps", () => {
  const data = normalizeReadings([row(now), row(now - 900000), row(now), { measured_at: "bad" }]);
  assert.equal(data.length, 2); assert.ok(data[0].time < data[1].time);
});
test("gaps above 20 minutes and nulls break lines; singletons remain", () => {
  const rows = normalizeReadings([row(now), row(now + 900000), row(now + 2700000), row(now + 3000000, {}), row(now + 3300000)]);
  assert.deepEqual(segments(rows, "battery_voltage").map(group => group.length), [2, 1, 1]);
});
test("constant battery range has padding; humidity and battery percentage are bounded", () => {
  const range = extent([3.477, 3.477], SERIES[3]);
  assert.ok(range[0] < 3.477 && range[1] > 3.477);
  assert.deepEqual(extent([0, 100], BATTERY_PERCENT), [0, 100]);
  const rh = extent([99, 100], SERIES[1]); assert.ok(rh[0] >= 0 && rh[1] <= 100);
});
test("bounded pagination keeps fixed range and required device/metrics", async () => {
  const calls = [];
  const result = await loadHistory("", 7, async url => {
    calls.push(new URL(url, "https://example.test"));
    return calls.length === 1 ? reply([row(now - 60000)], "next") : reply([row(now - 900000)]);
  }, now);
  assert.equal(result.rows.length, 2); assert.equal(calls.length, 2);
  for (const url of calls) { assert.equal(url.searchParams.get("device_id"), "balcony-weather-01"); assert.equal(url.searchParams.get("limit"), "1000"); }
  assert.equal(calls[0].searchParams.get("to"), calls[1].searchParams.get("to"));
  assert.equal(calls[1].searchParams.get("cursor"), "next");
});
test("errors do not retry; repeated cursor and oversized history fail rather than silently truncate", async () => {
  let count = 0;
  await assert.rejects(loadHistory("", 1, async () => { count++; return { ok: false, status: 503 }; }, now), /503/);
  assert.equal(count, 1);
  await assert.rejects(loadHistory("", 1, async () => reply([], "same"), now), /반복/);
  count = 0;
  await assert.rejects(loadHistory("", 7, async () => reply([], String(++count)), now), /한도/);
  assert.equal(count, 3);
});
test("empty history succeeds; invalid payload and period fail", async () => {
  assert.deepEqual((await loadHistory("", 1, async () => reply([]), now)).rows, []);
  await assert.rejects(loadHistory("", 30, async () => reply([]), now), /기간/);
  await assert.rejects(loadHistory("", 1, async () => ({ok: true, json: async () => ({})}), now), /형식/);
});

test("resizing preserves chart nodes, selection and battery mode; same width is a no-op", () => {
  let width = 360;
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.replacements = 0; }
    get clientWidth() { return width; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.replacements++; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, value) { this.events[key] = value; }
  }
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag) };
  try {
    const container = new Node("div");
    const values = { air_temperature: 18, humidity: 70, pressure: 1010, battery_voltage: 3.8 };
    const data = { from: now - 86400000, to: now, rows: normalizeReadings([row(now - 1800000, values), row(now - 900000, values)]) };
    const resize = renderHistory(container, data);
    const card = container.children.at(-1), plot = card.children.at(-1);
    const selector = card.children[0].children[0];
    selector.value = "percent"; selector.events.change();
    const svg = plot.children.find(node => node.tag === "svg"), readout = plot.children.at(-1);
    svg.events.keydown({key: "ArrowLeft", preventDefault() {}});
    const selected = readout.textContent, replacements = svg.replacements;
    resize(); resize();
    assert.equal(svg.replacements, replacements, "height-only resize must not rebuild even SVG children");
    assert.equal(container.replacements, 1);
    width = 700; resize();
    assert.equal(container.replacements, 1, "resizing must never remove the chart cards");
    assert.equal(card.children.at(-1), plot);
    assert.equal(plot.children.find(node => node.tag === "svg"), svg, "focusable element survives width change");
    assert.equal(readout.textContent, selected);
    assert.equal(selector.value, "percent");
    assert.equal(svg.attrs.viewBox, "0 0 700 250");
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
