import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { BALCONY_QUERY, balconySnapshot, jmaSnapshot } from "../../docs/dashboard/outdoor.js";

const now = Date.parse("2026-10-14T03:00:00Z");
function balcony() {
  return { reading: { measured_at: "2026-10-14T02:45:00Z",
    values: { air_temperature: 23.4, humidity: 60, pressure: 1010.2, battery_voltage: 3.9 },
    quality: { air_temperature: "valid", humidity: "valid", pressure: "valid", battery_voltage: "valid" }
  } };
}
function jma() {
  return { observed_at: "2026-10-14T02:50:00Z", current: {
    temperature: 24.1, humidity: 58, station_pressure: 1009, sea_level_pressure: 1020,
    precipitation_10m: 0, wind_speed: 1.5
  }, quality: { stale: false, fields: { temperature: "valid", humidity: "valid", station_pressure: "valid" } } };
}

test("approved balcony integration is enabled; query is station-scoped and bounded", () => {
  const window = { location: { hostname: "example.com", origin: "https://example.com" } };
  vm.runInNewContext(readFileSync(new URL("../../docs/weather-config.js", import.meta.url), "utf8"), { window });
  assert.equal(window.HYDROPONICS_CONFIG.balconyWeatherEnabled, true);
  const query = new URL(BALCONY_QUERY, "https://example.com");
  assert.equal(query.pathname, "/v1/readings/latest");
  assert.equal(query.searchParams.get("device_id"), "balcony-weather-01");
  assert.equal(query.searchParams.get("days"), "7");
});
test("fresh observations keep independent sources and station pressure, not sea-level pressure", () => {
  assert.equal(balconySnapshot(balcony(), "ready", now).current.temperature, 23.4);
  assert.equal(jmaSnapshot(jma(), "ready", now).current.temperature, 24.1);
  assert.equal(jmaSnapshot(jma(), "ready", now).current.pressure, 1009);
});
test("missing and bad-quality fields are never converted to zero or substituted", () => {
  const data = balcony();
  data.reading.values.humidity = null;
  data.reading.quality.pressure = "invalid";
  data.reading.values.air_temperature = "23.4";
  const result = balconySnapshot(data, "ready", now);
  assert.equal(result.condition, "partial");
  assert.equal(result.current.temperature, null);
  assert.equal(result.current.humidity, null);
  assert.equal(result.current.pressure, null);
  assert.equal(result.current.battery, 3.9);
});
test("old observations retain timestamp but are withheld from current values", () => {
  const result = balconySnapshot(balcony(), "ready", now + 21 * 60_000);
  assert.equal(result.condition, "stale");
  assert.equal(result.current.temperature, null);
  assert.equal(result.values.temperature, 23.4);
  assert.equal(result.age, 36 * 60_000);
});
test("empty, invalid/future timestamps and fetch errors do not present cached values as current", () => {
  assert.equal(balconySnapshot({ reading: null }, "ready", now).condition, "empty");
  for (const measured_at of [null, "bad", "2026-10-15T00:00:00Z"]) {
    const data = balcony(); data.reading.measured_at = measured_at;
    const result = balconySnapshot(data, "ready", now);
    assert.equal(result.condition, "invalid");
    assert.equal(result.current.temperature, null);
  }
  assert.equal(balconySnapshot(balcony(), "error", now).current.temperature, null);
});
test("JMA and balcony outages are independent, including zero-valued rain and temperature", () => {
  const data = jma(); data.current.temperature = 0;
  assert.equal(jmaSnapshot(data, "ready", now).current.temperature, 0);
  assert.equal(jmaSnapshot(data, "ready", now).current.precipitation, 0);
  assert.deepEqual(jmaSnapshot(data, "error", now).current, {});
  data.quality.stale = true;
  assert.equal(jmaSnapshot(data, "ready", now).fresh, false);
  assert.equal(balconySnapshot(balcony(), "ready", now).condition, "ready");
});
