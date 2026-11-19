import { estimatedBatteryPercent } from "./battery.mjs?v=20261117-35e";
import { intervalSeconds } from './schedule.mjs?v=20261117-policy';

export const METRICS = ["air_temperature", "humidity", "pressure", "battery_voltage"];
export const GAP_MS = 20 * 60 * 1000;
export const SERIES = [
  { key: "air_temperature", title: "기온", unit: "°C", digits: 1, color: "#bf593c", minSpan: 2 },
  { key: "humidity", title: "상대습도", unit: "%", digits: 1, color: "#267ca3", minSpan: 10, bounds: [0, 100] },
  { key: "pressure", title: "현지기압", unit: "hPa", digits: 1, color: "#805ab1", minSpan: 4 },
  { key: "battery_voltage", title: "배터리 전압", unit: "V", digits: 3, color: "#1b8067", minSpan: .05 },
];
export const BATTERY_PERCENT = { key: "battery_percent", title: "배터리 추정 잔량", unit: "%", digits: 0,
  color: "#1b8067", minSpan: 100, bounds: [0, 100] };

export function normalizeReadings(readings) {
  const byTime = new Map();
  for (const row of readings) {
    const time = Date.parse(row.measured_at);
    if (!Number.isFinite(time) || byTime.has(time)) continue;
    const values = Object.fromEntries(METRICS.map(key => [key,
      row.quality?.[key] === "valid" && typeof row.values?.[key] === "number" && Number.isFinite(row.values[key])
        ? row.values[key] : null]));
    values.battery_percent = estimatedBatteryPercent(values.battery_voltage);
    byTime.set(time, { time, values, interval: intervalSeconds(row.station_schedule), schedule: row.station_schedule });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function segments(rows, key) {
  const result = [];
  let current = [];
  let previous = null;
  for (const row of rows) {
    const value = row.values[key];
    if (!Number.isFinite(value)) { current = []; previous = row; continue; }
    const allowedGap = (Math.max(previous?.interval || 900, row.interval || 900) + 300) * 1000;
    if (!current.length || row.time - current.at(-1).time > allowedGap) {
      current = []; result.push(current);
    }
    current.push({ time: row.time, value });
    previous = row;
  }
  return result;
}

export function extent(values, spec) {
  if (!values.length) return spec.bounds ?? [0, 1];
  const low = Math.min(...values), high = Math.max(...values);
  const span = Math.max(spec.minSpan, high - low);
  const middle = (low + high) / 2;
  const range = [middle - span * .6, middle + span * .6];
  return spec.bounds ? [Math.max(spec.bounds[0], range[0]), Math.min(spec.bounds[1], range[1])] : range;
}

// Fixed range across pages, bounded requests, no retry or background polling.
export async function loadHistory(base, days, fetcher = fetch, now = Date.now()) {
  if (![1, 2, 7].includes(Number(days))) throw new Error("지원하지 않는 조회 기간입니다.");
  const to = Math.ceil(now / 60000) * 60000;
  const from = to - Number(days) * 86400000;
  const query = new URLSearchParams({ device_id: "balcony-weather-01", from: new Date(from).toISOString(),
    to: new Date(to).toISOString(), metrics: METRICS.join(","), limit: "1000" });
  const readings = [], cursors = new Set();
  for (let page = 0; page < 3; page++) {
    const response = await fetcher(`${base}/v1/readings?${query}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.readings) || !data.page || !("next_cursor" in data.page)) {
      throw new Error("기록 응답 형식을 확인할 수 없습니다.");
    }
    readings.push(...data.readings);
    const cursor = data.page.next_cursor;
    if (cursor === null) return { from, to, rows: normalizeReadings(readings).filter(row => row.time >= from && row.time < to) };
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("기록 페이지가 반복되었습니다.");
    cursors.add(cursor); query.set("cursor", cursor);
  }
  throw new Error("조회량 한도에 도달했습니다. 더 짧은 기간을 선택해주세요.");
}
