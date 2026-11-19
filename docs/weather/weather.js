import { estimatedBatteryPercent } from "./battery.mjs?v=20261117-35e";
import { setupHistory } from "./history.mjs?v=20261117-policy";
import { scheduleLabel, staleMilliseconds } from './schedule.mjs?v=20261117-policy';
import { renderNightClosing } from './night-closing.mjs?v=20261117-astronomy';
const base = location.hostname.endsWith("workers.dev") || ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "" : "https://hydroponics-jma-weather.flammenwerfer41.workers.dev";
const status = document.querySelector("#status");
let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch(`${base}/v1/readings/latest?device_id=balcony-weather-01&days=7&metrics=air_temperature,humidity,pressure,battery_voltage`,
      { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { reading, night_closing } = await response.json();
    renderNightClosing(night_closing);
    if (!reading) {
      for (const id of ["temperature", "humidity", "pressure", "battery"]) document.getElementById(id).textContent = "--";
      document.querySelector("#charge").textContent = "추정 잔량 --";
      document.querySelector('#schedule').textContent = '관측 주기 미확인';
      status.textContent = "최근 7일 내 기상대 관측값이 없습니다."; return;
    }
    const valid = metric => reading.quality?.[metric] === "valid" && typeof reading.values?.[metric] === "number"
      ? reading.values[metric] : null;
    for (const [id, metric, digits] of [["temperature", "air_temperature", 1], ["humidity", "humidity", 1],
      ["pressure", "pressure", 1], ["battery", "battery_voltage", 2]]) {
      const value = valid(metric);
      document.getElementById(id).textContent = value === null ? "--" : value.toFixed(digits);
    }
    const percent = estimatedBatteryPercent(valid("battery_voltage"));
    document.querySelector("#charge").textContent = percent === null ? "추정 잔량 --" : `추정 잔량 약 ${percent}%`;
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(reading.measured_at)) / 60000));
    document.querySelector('#schedule').textContent = scheduleLabel(reading.station_schedule) +
      (reading.astronomy ? ` · 천문 기준 ${reading.astronomy.night ? '밤' : '낮'} · 태양 고도 ${reading.astronomy.solar_altitude_deg.toFixed(1)}°` : '');
    status.textContent = `${new Date(reading.measured_at).toLocaleString("ko-KR", { timeZone: "Asia/Tokyo" })} JST · ${age}분 전${age * 60000 > staleMilliseconds(reading.station_schedule) ? " · 갱신 지연" : ""}`;
  } catch (error) { status.textContent = `관측값 조회 실패: ${error.message}. 표시된 값은 이전 조회값일 수 있습니다.`; }
  finally { busy = false; }
}
document.querySelector("#refresh").addEventListener("click", refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 900000);
refresh();
setupHistory(base);
