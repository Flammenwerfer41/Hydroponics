import { estimatedBatteryPercent, BATTERY_MODEL_VERSION } from './battery.mjs?v=20261117-35e';
const stamp = value => new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' JST';
export function nightClosingView(reading, now=Date.now()) {
  if (!reading?.astronomy?.night_closing) return {value:'야간 마감 관측 대기',time:'최근 7일 내 수신된 마감 기록이 없습니다.',note:'별도 기상 없이 저녁 천문박명 종료 후 첫 정규 관측을 사용합니다.'};
  const measured=Date.parse(reading.measured_at), dusk=Date.parse(reading.astronomy.astronomical_dusk);
  if (!Number.isFinite(measured)||!Number.isFinite(dusk)||measured<dusk||measured>now+60000)
    return {value:'마감 시각 확인 필요',time:'유효하지 않은 마감 기록입니다.',note:'이전 값을 오늘 값으로 대체하지 않습니다.'};
  const valid=key=>reading.quality?.[key]==='valid' && typeof reading.values?.[key]==='number' && Number.isFinite(reading.values[key]) ? reading.values[key] : null;
  const voltage=valid('battery_voltage'), percent=estimatedBatteryPercent(voltage), temperature=valid('air_temperature');
  return {value:percent===null?'야간 마감 전압 측정 누락':`추정 잔량 ${percent}% · ${voltage.toFixed(3)}V`,
    time:`${stamp(measured)} 측정 · 천문박명 종료 ${stamp(dusk)} · ${Math.round((measured-dusk)/60000)}분 후`,
    note:`${now-measured>36*3600000?'오래된 기록 · 새 마감 관측 미수신. ':''}${temperature===null?'당시 기온 미측정':`당시 기온 ${temperature.toFixed(1)}°C`} · 측정 당시 부하 상태의 전압이며 휴지전압이 아닙니다.`,
    model:`추정 잔량: ${BATTERY_MODEL_VERSION} · 천문 계산: ${reading.astronomy.model}`};
}
export function renderNightClosing(reading, now=Date.now()) {
  const view=nightClosingView(reading,now);
  for(const key of ['value','time','note','model']) document.getElementById(`night-${key}`).textContent=view[key]||'';
}
