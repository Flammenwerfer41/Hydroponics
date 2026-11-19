import { staleMilliseconds } from '../weather/schedule.mjs?v=20261117-policy';
// Prepared integration: imported by the dashboard, mounted only behind an opt-in flag.
export const BALCONY_QUERY = "/v1/readings/latest?device_id=balcony-weather-01&days=7&metrics=air_temperature,humidity,pressure,battery_voltage";
export const BALCONY_STALE_MS = 35 * 60_000;

const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
function observationTime(value, now) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now + 60_000 ? time : null;
}

export function balconySnapshot(payload, status = "ready", now = Date.now()) {
  const reading = payload?.reading;
  const time = observationTime(reading?.measured_at, now);
  const valid = key => reading?.quality?.[key] === "valid" ? number(reading?.values?.[key]) : null;
  const values = {
    temperature: valid("air_temperature"), humidity: valid("humidity"),
    pressure: valid("pressure"), battery: valid("battery_voltage")
  };
  const age = time === null ? null : Math.max(0, now - time);
  const condition = status !== "ready" ? status : !reading ? "empty" : time === null ? "invalid"
    : age > staleMilliseconds(reading.station_schedule) ? "stale"
    : [values.temperature, values.humidity, values.pressure].some(v => v === null) ? "partial" : "ready";
  return { condition, time, age, values,
    // Never substitute JMA for missing/stale balcony values.
    current: ["ready", "partial"].includes(condition) ? values
      : { temperature: null, humidity: null, pressure: null, battery: null }
  };
}

export function jmaSnapshot(payload, status = "ready", now = Date.now()) {
  const time = observationTime(payload?.observed_at, now);
  const fresh = status === "ready" && time !== null && payload?.current &&
    !payload?.quality?.stale && now - time <= 30 * 60_000;
  const valid = key => {
    const quality = payload?.quality?.fields?.[key];
    return quality && quality !== "valid" ? null : number(payload?.current?.[key]);
  };
  return { time, fresh, current: fresh ? {
    temperature: valid("temperature"), humidity: valid("humidity"),
    pressure: valid("station_pressure"), precipitation: valid("precipitation_10m"),
    wind: valid("wind_speed"), feelsLike: valid("apparent_temperature")
  } : {}, condition: payload?.condition?.code };
}

const labels = {
  ko: {
    balcony: "발코니 실측", compare: "JMA와 비교 · 상세", temperature: "기온", humidity: "습도",
    pressure: "현지기압", rain: "강수(10분)", wind: "풍속", detail: "기상대 상태",
    loading: "관측값 확인 중", error: "조회 실패", empty: "최근 7일 관측 없음",
    invalid: "관측 시각 확인 불가", stale: "관측 지연 · 현재값 표시 중지",
    partial: "일부 센서값 없음", ready: "정상 수신", minute: "분 전",
    note: "서로 다른 장소·시각의 관측입니다. 기압은 해면기압으로 환산하지 않은 값이며 단순 오차 비교용이 아닙니다.",
    feels: "JMA 계산 체감", jmaUnavailable: "JMA 관측 지연 또는 조회 불가",
    precipitation: "강수 관측", sunshine: "일조 관측", dry: "강수 없음", unknown: "관측 불가"
  },
  ja: {
    balcony: "バルコニー実測", compare: "JMAと比較・詳細", temperature: "気温", humidity: "湿度",
    pressure: "現地気圧", rain: "降水(10分)", wind: "風速", detail: "気象計の状態",
    loading: "観測値を確認中", error: "取得失敗", empty: "過去7日間の観測なし",
    invalid: "観測時刻を確認できません", stale: "観測遅延・現在値の表示停止",
    partial: "一部のセンサー値なし", ready: "正常受信", minute: "分前",
    note: "異なる場所・時刻の観測です。気圧は海面更正していない値で、単純な誤差比較には使えません。",
    feels: "JMA計算体感", jmaUnavailable: "JMA観測遅延または取得失敗",
    precipitation: "降水を観測", sunshine: "日照あり", dry: "降水なし", unknown: "観測不能"
  }
};

export function createOutdoorPanel(root) {
  // Retain the existing forecast DOM/renderer and its independent publication timestamp.
  const forecast = root.querySelector(".forecast-summary");
  root.classList.add("balcony-weather-panel");
  root.removeAttribute("aria-labelledby");
  root.innerHTML = `
    <h3 class="outdoor-heading" data-label="balcony"></h3>
    <div class="v2-weather-grid">
      <div class="v2-mini"><span aria-hidden="true">♨</span><strong><span data-value="temperature">--</span><small>°C</small></strong><small data-label="temperature"></small></div>
      <div class="v2-mini"><span aria-hidden="true">◆</span><strong><span data-value="humidity">--</span><small>%</small></strong><small data-label="humidity"></small></div>
    </div>
    <p class="outdoor-status" role="status"></p>
    <p class="outdoor-time"></p>
    <h4 class="outdoor-jma-heading">JMA · <span class="outdoor-condition"></span></h4>
    <div class="v2-weather-grid">
      <div class="v2-mini"><span aria-hidden="true">☂</span><strong><span data-value="precipitation">--</span><small>mm</small></strong><small data-label="rain"></small></div>
      <div class="v2-mini"><span aria-hidden="true">≋</span><strong><span data-value="wind">--</span><small>m/s</small></strong><small data-label="wind"></small></div>
    </div>
    <p class="outdoor-jma-time"></p>
    <details class="outdoor-comparison"><summary data-label="compare"></summary>
      <div class="outdoor-comparison-body">
        <table><thead><tr><th></th><th scope="col" data-label="balcony"></th><th scope="col">JMA</th></tr></thead>
        <tbody>
          <tr><th scope="row" data-label="temperature"></th><td data-compare="balcony-temperature"></td><td data-compare="jma-temperature"></td></tr>
          <tr><th scope="row" data-label="humidity"></th><td data-compare="balcony-humidity"></td><td data-compare="jma-humidity"></td></tr>
          <tr><th scope="row" data-label="pressure"></th><td data-compare="balcony-pressure"></td><td data-compare="jma-pressure"></td></tr>
        </tbody></table>
        <p><span data-label="feels"></span>: <span data-value="feelsLike">--</span>°C</p>
        <p class="outdoor-stations"></p>
        <p data-label="note"></p>
        <a href="weather/" data-label="detail"></a> ·
        <a href="https://www.jma.go.jp/bosai/amedas/" target="_blank" rel="noreferrer">JMA AMeDAS</a>
      </div>
    </details>`;
  if (forecast) root.insertBefore(forecast, root.querySelector(".outdoor-comparison"));
  const set = (selector, text) => { root.querySelector(selector).textContent = text; };
  const fixed = v => typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "--";
  return ({ balcony, balconyStatus, jma, jmaStatus, language = "ko", now = Date.now() }) => {
    const lang = language === "ja" ? "ja" : "ko";
    const text = labels[lang];
    const b = balconySnapshot(balcony, balconyStatus, now);
    const j = jmaSnapshot(jma, jmaStatus, now);
    root.querySelectorAll("[data-label]").forEach(node => { node.textContent = text[node.dataset.label]; });
    root.setAttribute("aria-label", text.balcony + " / JMA");
    const time = value => value === null ? "--" : new Date(value).toLocaleString(
      lang === "ja" ? "ja-JP" : "ko-KR", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " JST";
    set(".outdoor-status", text[b.condition]);
    root.dataset.observationStatus = b.condition;
    set(".outdoor-time", `${time(b.time)}${b.age === null ? "" : ` · ${Math.floor(b.age / 60000)}${text.minute}`}`);
    set(".outdoor-jma-time", j.fresh ? `JMA · ${time(j.time)}` : `${text.jmaUnavailable} · ${time(j.time)}`);
    set(".outdoor-condition", j.fresh ? (text[j.condition] || text.unknown) : text.unknown);
    const stationName = station => station?.name || station?.name_en || "--";
    set(".outdoor-stations", `JMA ${text.temperature} / ${text.humidity} / ${text.wind}: ${stationName(jma?.stations?.environment)} · ${text.rain}: ${stationName(jma?.stations?.precipitation)}`);
    for (const key of ["temperature", "humidity"]) set(`[data-value="${key}"]`, fixed(b.current[key]));
    for (const key of ["precipitation", "wind", "feelsLike"]) set(`[data-value="${key}"]`, fixed(j.current[key]));
    for (const [key, unit] of [["temperature", "°C"], ["humidity", "%"], ["pressure", "hPa"]]) {
      set(`[data-compare="balcony-${key}"]`, `${fixed(b.current[key])} ${unit}`);
      set(`[data-compare="jma-${key}"]`, `${fixed(j.current[key])} ${unit}`);
    }
  };
}
