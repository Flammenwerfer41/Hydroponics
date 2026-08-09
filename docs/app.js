"use strict";

const DATA_API_BASE = String(globalThis.HYDROPONICS_CONFIG?.dataApiBaseUrl || "")
  .trim()
  .replace(/\/+$/, "");
const DASHBOARD_METRICS = Object.freeze([
  "air_temperature",
  "humidity",
  "pressure",
  "wifi_rssi",
  "water_temperature"
]);
const HISTORY_METRICS = Object.freeze([
  "air_temperature",
  "humidity",
  "pressure",
  "water_temperature"
]);
const CURRENT_REFRESH_MS = 60_000;
const CURRENT_LOOKBACK_RESULTS = 30;
const HISTORY_REFRESH_MS = 120_000;
const HISTORY_FULL_REFRESH_MS = 60 * 60_000;
const RAW_HISTORY_OVERLAP_MS = 10 * 60_000;
const AGGREGATE_HISTORY_OVERLAP_MS = 2 * 60 * 60_000;
const WEATHER_REFRESH_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const JST_TIME_ZONE = "Asia/Tokyo";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LANGUAGE_STORAGE_KEY = "hydroponics-language";
const WEATHER_API_URL = String(
  globalThis.HYDROPONICS_CONFIG?.weatherApiUrl || `${DATA_API_BASE}/v1/current`
).trim();

const TRANSLATIONS = {
  ko: {
    "meta.description": "ESP32 수경재배 환경 센서의 온도, 습도, 기압과 조명 상태를 확인하는 대시보드",
    "language.selector": "표시 언어",
    "hero.copy": "수경재배 환경과 조명 상태를 원격으로 확인합니다.",
    "hero.admin": "관리",
    "hero.journal": "재배일지",
    "connection.loading": "연결 확인 중",
    "connection.failed": "데이터 연결 실패",
    "connection.online": "정상 수신 중",
    "connection.stale": "데이터 지연",
    "connection.offline": "장치 오프라인",
    "current.kicker": "현재 환경",
    "current.title": "지금의 재배 공간",
    "current.loading": "최근 데이터 불러오는 중…",
    "current.timeUnavailable": "수신 시각 확인 불가",
    "current.loadFailed": "최근 데이터를 불러오지 못했습니다.",
    "metric.temperature": "온도",
    "metric.humidity": "습도",
    "metric.pressure": "기압",
    "metric.waterTemperature": "수온",
    "metric.bme280": "BME280 센서",
    "scene.aria": "수경재배 시스템 개요",
    "scene.airKicker": "잎 주변 공기",
    "scene.airTitle": "재배 공간",
    "scene.waterKicker": "화분 속 양액",
    "scene.waterSensor": "DS18B20 · GPIO 21",
    "status.measurementWaiting": "측정 대기 중",
    "status.lastMeasured": "{time} 측정",
    "status.noRecentData": "최근 정상 데이터 없음",
    "status.calculationWaiting": "계산 대기 중",
    "temperature.low": "다소 낮은 온도",
    "temperature.high": "높은 온도",
    "temperature.stable": "안정적인 범위",
    "humidity.dry": "건조한 환경",
    "humidity.high": "습도가 높은 환경",
    "humidity.stable": "안정적인 범위",
    "insight.kicker": "실내 환경 해석",
    "insight.title": "온도와 습도로 계산한 참고값",
    "insight.basis": "현재 측정값 기준",
    "insight.discomfort": "불쾌지수",
    "insight.vpdReference": "식물 증산 참고값",
    "insight.dewPoint": "이슬점",
    "insight.dewReference": "결로 참고값",
    "insight.comfortable": "대체로 쾌적",
    "insight.normal": "보통",
    "insight.slightlyUncomfortable": "약간 불쾌",
    "insight.uncomfortable": "불쾌감 높음",
    "insight.lowVpd": "증산이 낮은 범위",
    "insight.highVpd": "증산이 높은 범위",
    "insight.balancedVpd": "균형적인 참고 범위",
    "insight.condensationClose": "결로에 가까운 상태",
    "insight.dewGap": "현재 온도보다 {value}°C 낮음",
    "light.kicker": "LED 조명",
    "light.checking": "상태 확인 중",
    "light.power": "현재 소비전력",
    "light.runtimeToday": "오늘 가동시간",
    "light.on": "켜짐",
    "light.off": "꺼짐",
    "light.unknown": "상태 확인 불가",
    "light.running": "재배 조명이 작동 중입니다.",
    "light.waiting": "재배 조명이 대기 중입니다.",
    "light.noData": "SwitchBot 데이터가 없습니다.",
    "weather.kicker": "주변 날씨",
    "weather.checking": "날씨 확인 중",
    "weather.loading": "JMA 관측값 불러오는 중…",
    "weather.outdoorTemperature": "외부 기온",
    "weather.feelsLike": "계산 체감",
    "weather.precipitation": "강수",
    "weather.wind": "풍속",
    "weather.source": "JMA AMeDAS 직접 관측값",
    "weather.updated": "JMA {time} 관측 · 도쿄/세타가야",
    "weather.updatedStale": "JMA {time} 관측 · 자료 지연",
    "weather.unavailable": "날씨 확인 불가",
    "weather.retry": "잠시 후 자동으로 다시 시도합니다.",
    "weather.notConfigured": "JMA Worker 주소 설정 필요",
    "weather.precipitationObserved": "강수 관측",
    "weather.sunshineObserved": "일조 관측",
    "weather.dryObserved": "강수 없음",
    "weather.observationUnknown": "관측 불가",
    "forecast.title": "도쿄지방 예보",
    "forecast.updated": "{time} 발표",
    "forecast.unavailable": "예보를 가져올 수 없음",
    "forecast.clear": "맑음",
    "forecast.cloudy": "흐림",
    "forecast.rain": "비",
    "forecast.snow": "눈",
    "forecast.mixed": "비 또는 눈",
    "forecast.unknown": "날씨 미상",
    "history.kicker": "환경 기록",
    "history.title": "시간에 따른 변화",
    "history.rangeSelector": "그래프 기간",
    "history.rangeDay": "오늘 비교",
    "history.rangeWeek": "7일",
    "history.rangeMonth": "30일",
    "history.loading": "그래프 데이터 불러오는 중…",
    "history.loadingRange": "{range} 데이터 불러오는 중…",
    "history.ready": "{range} · {count}개 데이터",
    "history.loadFailed": "그래프 데이터를 불러오지 못했습니다.",
    "history.retry": "잠시 후 자동으로 다시 시도합니다.",
    "range.day.label": "오늘과 전날",
    "range.day.resolution": "2분 원본 데이터",
    "range.week.label": "최근 7일",
    "range.week.resolution": "1시간 평균",
    "range.month.label": "최근 30일",
    "range.month.resolution": "1시간 평균",
    "common.today": "오늘",
    "common.previousDay": "전날",
    "common.checking": "확인 중…",
    "common.checkingPlain": "확인 중",
    "common.noData": "표시할 데이터 없음",
    "timeline.title": "조명 가동 구간",
    "timeline.previousAria": "전날 조명 가동 구간",
    "timeline.currentAria": "선택한 기간의 조명 가동 구간",
    "timeline.light": "조명",
    "timeline.noOnRecord": "ON 구간 기록 없음",
    "timeline.daySummary": "오늘 {today} · 전날 {previous}",
    "timeline.rangeSummary": "표시 구간 약 {runtime}",
    "chart.temperatureAria": "온도 변화 그래프",
    "chart.humidityAria": "습도 변화 그래프",
    "chart.pressureAria": "기압 변화 그래프",
    "chart.waterTemperatureAria": "수온 변화 그래프",
    "chart.average": "평균 {value} {unit}",
    "chart.stats": "최저 {minimum} · 최고 {maximum}",
    "chart.noData": "표시할 데이터가 없습니다.",
    "system.aria": "장치 상태",
    "system.wifi": "Wi-Fi 신호",
    "system.lastEntry": "최신 레코드",
    "system.interval": "데이터 간격",
    "system.twoMinutes": "2분",
    "system.uploadCycle": "ESP32 업로드 주기",
    "wifi.unavailable": "확인 불가",
    "wifi.excellent": "매우 좋음",
    "wifi.good": "좋음",
    "wifi.normal": "보통",
    "wifi.weak": "약함",
    "footer.links": "관련 링크",
    "noscript": "이 대시보드는 Cloudflare 센서 데이터를 불러오기 위해 JavaScript가 필요합니다.",
    "relative.justNow": "방금 전",
    "relative.seconds": "{value}초 전",
    "relative.minutes": "{value}분 전",
    "relative.hours": "{value}시간 전",
    "relative.days": "{value}일 전",
    "runtime.minutes": "{minutes}분",
    "runtime.hours": "{hours}시간",
    "runtime.hoursMinutes": "{hours}시간 {minutes}분"
  },
  ja: {
    "meta.description": "ESP32水耕栽培環境センサーの温度・湿度・気圧と照明状態を確認するダッシュボード",
    "language.selector": "表示言語",
    "hero.copy": "水耕栽培の環境と照明の状態を遠隔で確認できます。",
    "hero.admin": "管理",
    "hero.journal": "栽培日誌",
    "connection.loading": "接続確認中",
    "connection.failed": "データ接続に失敗",
    "connection.online": "データ受信中",
    "connection.stale": "データ遅延",
    "connection.offline": "デバイスはオフライン",
    "current.kicker": "現在の環境",
    "current.title": "現在の栽培環境",
    "current.loading": "最新データを読み込み中…",
    "current.timeUnavailable": "受信時刻を確認できません",
    "current.loadFailed": "最新データを取得できませんでした。",
    "metric.temperature": "温度",
    "metric.humidity": "湿度",
    "metric.pressure": "気圧",
    "metric.waterTemperature": "水温",
    "metric.bme280": "BME280センサー",
    "scene.aria": "水耕栽培システムの概要",
    "scene.airKicker": "葉の周辺環境",
    "scene.airTitle": "栽培空間",
    "scene.waterKicker": "容器内の養液",
    "scene.waterSensor": "DS18B20 · GPIO 21",
    "status.measurementWaiting": "測定待ち",
    "status.lastMeasured": "{time}に測定",
    "status.noRecentData": "最近の正常データなし",
    "status.calculationWaiting": "計算待ち",
    "temperature.low": "やや低い温度",
    "temperature.high": "高い温度",
    "temperature.stable": "安定した範囲",
    "humidity.dry": "乾燥した環境",
    "humidity.high": "湿度が高い環境",
    "humidity.stable": "安定した範囲",
    "insight.kicker": "室内環境の目安",
    "insight.title": "温度と湿度から算出した参考値",
    "insight.basis": "現在の測定値に基づく",
    "insight.discomfort": "不快指数",
    "insight.vpdReference": "植物の蒸散の参考値",
    "insight.dewPoint": "露点",
    "insight.dewReference": "結露の参考値",
    "insight.comfortable": "おおむね快適",
    "insight.normal": "普通",
    "insight.slightlyUncomfortable": "やや不快",
    "insight.uncomfortable": "不快感が高い",
    "insight.lowVpd": "蒸散が少ない範囲",
    "insight.highVpd": "蒸散が多い範囲",
    "insight.balancedVpd": "バランスのよい参考範囲",
    "insight.condensationClose": "結露に近い状態",
    "insight.dewGap": "現在の温度より{value}°C低い",
    "light.kicker": "LED照明",
    "light.checking": "状態確認中",
    "light.power": "現在の消費電力",
    "light.runtimeToday": "本日の稼働時間",
    "light.on": "点灯",
    "light.off": "消灯",
    "light.unknown": "状態を確認できません",
    "light.running": "栽培照明が稼働中です。",
    "light.waiting": "栽培照明は待機中です。",
    "light.noData": "SwitchBotのデータがありません。",
    "weather.kicker": "周辺の天気",
    "weather.checking": "天気を確認中",
    "weather.loading": "JMA観測値を読み込み中…",
    "weather.outdoorTemperature": "外気温",
    "weather.feelsLike": "計算体感温度",
    "weather.precipitation": "降水量",
    "weather.wind": "風速",
    "weather.source": "JMA AMeDAS直接観測値",
    "weather.updated": "JMA {time}観測 · 東京/世田谷",
    "weather.updatedStale": "JMA {time}観測 · データ遅延",
    "weather.unavailable": "天気を取得できません",
    "weather.retry": "しばらくしてから自動的に再試行します。",
    "weather.notConfigured": "JMA Worker URLの設定が必要です",
    "weather.precipitationObserved": "降水を観測",
    "weather.sunshineObserved": "日照あり",
    "weather.dryObserved": "降水なし",
    "weather.observationUnknown": "観測不能",
    "forecast.title": "東京地方予報",
    "forecast.updated": "{time}発表",
    "forecast.unavailable": "予報を取得できません",
    "forecast.clear": "晴れ",
    "forecast.cloudy": "くもり",
    "forecast.rain": "雨",
    "forecast.snow": "雪",
    "forecast.mixed": "雨または雪",
    "forecast.unknown": "天気不明",
    "history.kicker": "環境履歴",
    "history.title": "時間による変化",
    "history.rangeSelector": "グラフの期間",
    "history.rangeDay": "今日を比較",
    "history.rangeWeek": "7日",
    "history.rangeMonth": "30日",
    "history.loading": "グラフデータを読み込み中…",
    "history.loadingRange": "{range}のデータを読み込み中…",
    "history.ready": "{range} · {count}件",
    "history.loadFailed": "グラフデータを取得できませんでした。",
    "history.retry": "しばらくしてから自動的に再試行します。",
    "range.day.label": "今日と前日",
    "range.day.resolution": "2分間隔の元データ",
    "range.week.label": "直近7日間",
    "range.week.resolution": "1時間平均",
    "range.month.label": "直近30日間",
    "range.month.resolution": "1時間平均",
    "common.today": "今日",
    "common.previousDay": "前日",
    "common.checking": "確認中…",
    "common.checkingPlain": "確認中",
    "common.noData": "表示できるデータがありません",
    "timeline.title": "照明の稼働時間帯",
    "timeline.previousAria": "前日の照明稼働時間帯",
    "timeline.currentAria": "選択期間の照明稼働時間帯",
    "timeline.light": "照明",
    "timeline.noOnRecord": "点灯記録なし",
    "timeline.daySummary": "今日 {today} · 前日 {previous}",
    "timeline.rangeSummary": "表示期間 約{runtime}",
    "chart.temperatureAria": "温度変化グラフ",
    "chart.humidityAria": "湿度変化グラフ",
    "chart.pressureAria": "気圧変化グラフ",
    "chart.waterTemperatureAria": "水温変化グラフ",
    "chart.average": "平均 {value} {unit}",
    "chart.stats": "最低 {minimum} · 最高 {maximum}",
    "chart.noData": "表示できるデータがありません。",
    "system.aria": "デバイスの状態",
    "system.wifi": "Wi-Fi信号",
    "system.lastEntry": "最新レコード",
    "system.interval": "データ間隔",
    "system.twoMinutes": "2分",
    "system.uploadCycle": "ESP32アップロード周期",
    "wifi.unavailable": "確認できません",
    "wifi.excellent": "非常に良好",
    "wifi.good": "良好",
    "wifi.normal": "普通",
    "wifi.weak": "弱い",
    "footer.links": "関連リンク",
    "noscript": "このダッシュボードでCloudflareのセンサーデータを読み込むにはJavaScriptが必要です。",
    "relative.justNow": "たった今",
    "relative.seconds": "{value}秒前",
    "relative.minutes": "{value}分前",
    "relative.hours": "{value}時間前",
    "relative.days": "{value}日前",
    "runtime.minutes": "{minutes}分",
    "runtime.hours": "{hours}時間",
    "runtime.hoursMinutes": "{hours}時間{minutes}分"
  }
};

const RANGE_CONFIG = {
  day: {
    endpoint: "/v1/readings",
    query: "days=2&limit=1000&device_id=esp32-01",
    paginated: true,
    resolutionKey: "range.day.resolution",
    labelKey: "range.day.label",
    bucketSeconds: 120
  },
  week: {
    endpoint: "/v1/history/hourly",
    query: "days=7&device_id=esp32-01",
    resolutionKey: "range.week.resolution",
    labelKey: "range.week.label",
    bucketSeconds: 3600
  },
  month: {
    endpoint: "/v1/history/hourly",
    query: "days=30&device_id=esp32-01",
    resolutionKey: "range.month.resolution",
    labelKey: "range.month.label",
    bucketSeconds: 3600
  }
};

const CHART_CONFIG = {
  temperature: {
    canvasId: "temperatureChart",
    tooltipId: "temperatureTooltip",
    summaryId: "tempSummary",
    statsId: "tempStats",
    field: "temperature",
    unit: "°C",
    decimals: 1,
    cssColor: "--temperature",
    minimumSpan: 10,
    step: 2.5
  },
  humidity: {
    canvasId: "humidityChart",
    tooltipId: "humidityTooltip",
    summaryId: "humiditySummary",
    statsId: "humidityStats",
    field: "humidity",
    unit: "%",
    decimals: 1,
    cssColor: "--humidity",
    minimumSpan: 20,
    step: 5
  },
  pressure: {
    canvasId: "pressureChart",
    tooltipId: "pressureTooltip",
    summaryId: "pressureSummary",
    statsId: "pressureStats",
    field: "pressure",
    unit: "hPa",
    decimals: 1,
    cssColor: "--pressure",
    minimumSpan: 20,
    step: 5
  },
  waterTemperature: {
    canvasId: "waterTemperatureChart",
    tooltipId: "waterTemperatureTooltip",
    summaryId: "waterTempSummary",
    statsId: "waterTempStats",
    field: "waterTemperature",
    unit: "°C",
    decimals: 1,
    cssColor: "--water",
    minimumSpan: 10,
    step: 2.5
  }
};

const state = {
  language: initialLanguage(),
  range: "day",
  historyTargetRange: "day",
  history: [],
  lightHistory: [],
  historyStatus: "loading",
  historySequence: 0,
  currentSequence: 0,
  currentFeed: null,
  currentFailed: false,
  historyController: null,
  currentController: null,
  currentTimer: 0,
  historyTimer: 0,
  historyFullRefreshAt: 0,
  weatherTimer: 0,
  resizeFrame: 0,
  rangeStart: 0,
  rangeEnd: 1,
  previousStart: 0,
  todayStart: 0,
  weatherController: null,
  weatherEnabled: false,
  weatherData: null,
  weatherStatus: "loading",
  charts: {}
};

const element = (id) => document.getElementById(id);

function initialLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "ja" ? "ja" : "ko";
  } catch {
    return "ko";
  }
}

function t(key, replacements = {}) {
  const dictionary = TRANSLATIONS[state.language] || TRANSLATIONS.ko;
  const template = dictionary[key] || TRANSLATIONS.ko[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template
  );
}

function locale() {
  return state.language === "ja" ? "ja-JP" : "ko-KR";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dataApiUrl(path) {
  return `${DATA_API_BASE}${path}`;
}

function fixed(value, decimals = 1) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "--";
}

function formatRuntime(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "--";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (hours === 0) return t("runtime.minutes", { minutes: remainder });
  if (remainder === 0) return t("runtime.hours", { hours });
  return t("runtime.hoursMinutes", { hours, minutes: remainder });
}

function formatJst(date, options) {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: JST_TIME_ZONE,
    ...options
  }).format(date);
}

function jstMidnight(timestamp = Date.now()) {
  const shifted = new Date(timestamp + JST_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - JST_OFFSET_MS;
}

function historyDomain(range) {
  const now = Date.now();
  if (range === "day") {
    const todayStart = jstMidnight(now);
    return {
      start: todayStart,
      end: todayStart + DAY_MS,
      previousStart: todayStart - DAY_MS,
      todayStart
    };
  }

  const duration = range === "week" ? 7 * DAY_MS : 30 * DAY_MS;
  return {
    start: now - duration,
    end: now,
    previousStart: 0,
    todayStart: 0
  };
}

function relativeTime(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return t("relative.justNow");
  if (seconds < 60) return t("relative.seconds", { value: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("relative.minutes", { value: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("relative.hours", { value: hours });
  return t("relative.days", { value: Math.floor(hours / 24) });
}

function temperatureDescription(value) {
  if (!Number.isFinite(value)) return t("status.measurementWaiting");
  if (value < 15) return t("temperature.low");
  if (value > 32) return t("temperature.high");
  return t("temperature.stable");
}

function humidityDescription(value) {
  if (!Number.isFinite(value)) return t("status.measurementWaiting");
  if (value < 35) return t("humidity.dry");
  if (value > 75) return t("humidity.high");
  return t("humidity.stable");
}

function discomfortDescription(value) {
  if (!Number.isFinite(value)) return t("status.calculationWaiting");
  if (value < 68) return t("insight.comfortable");
  if (value < 75) return t("insight.normal");
  if (value < 80) return t("insight.slightlyUncomfortable");
  return t("insight.uncomfortable");
}

function vpdDescription(value) {
  if (!Number.isFinite(value)) return t("status.calculationWaiting");
  if (value < 0.4) return t("insight.lowVpd");
  if (value > 1.6) return t("insight.highVpd");
  return t("insight.balancedVpd");
}

function renderDerivedMetrics(temperature, humidity) {
  if (
    !Number.isFinite(temperature) ||
    !Number.isFinite(humidity) ||
    humidity <= 0 ||
    humidity > 100
  ) {
    element("discomfortIndex").textContent = "--";
    element("vpdValue").textContent = "--";
    element("dewPoint").textContent = "--";
    element("discomfortNote").textContent = t("status.calculationWaiting");
    element("vpdNote").textContent = t("insight.vpdReference");
    element("dewPointNote").textContent = t("insight.dewReference");
    return;
  }

  const discomfort =
    0.81 * temperature +
    0.01 * humidity * (0.99 * temperature - 14.3) +
    46.3;
  const saturationPressure =
    0.6108 * Math.exp((17.27 * temperature) / (temperature + 237.3));
  const vpd = saturationPressure * (1 - humidity / 100);
  const gamma =
    Math.log(humidity / 100) +
    (17.62 * temperature) / (243.12 + temperature);
  const dewPoint = (243.12 * gamma) / (17.62 - gamma);
  const condensationGap = temperature - dewPoint;

  element("discomfortIndex").textContent = fixed(discomfort, 0);
  element("discomfortNote").textContent = discomfortDescription(discomfort);
  element("vpdValue").textContent = fixed(vpd, 2);
  element("vpdNote").textContent = vpdDescription(vpd);
  element("dewPoint").textContent = fixed(dewPoint, 1);
  element("dewPointNote").textContent =
    condensationGap <= 2
      ? t("insight.condensationClose")
      : t("insight.dewGap", { value: fixed(condensationGap, 1) });
}

function wifiDescription(rssi) {
  if (!Number.isFinite(rssi)) return t("wifi.unavailable");
  if (rssi >= -50) return t("wifi.excellent");
  if (rssi >= -60) return t("wifi.good");
  if (rssi >= -70) return t("wifi.normal");
  return t("wifi.weak");
}

async function fetchJson(url, controllerRef) {
  const controller = new AbortController();
  const previous = state[controllerRef];
  state[controllerRef] = controller;
  if (previous) previous.abort();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error("요청 시간 초과");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (state[controllerRef] === controller) state[controllerRef] = null;
  }
}

function weatherConditionInfo(code) {
  if (code === "precipitation") {
    return { icon: "🌧️", label: t("weather.precipitationObserved") };
  }
  if (code === "sunshine") {
    return { icon: "☀️", label: t("weather.sunshineObserved") };
  }
  if (code === "dry") {
    return { icon: "◯", label: t("weather.dryObserved") };
  }
  return { icon: "·", label: t("weather.observationUnknown") };
}

function forecastConditionInfo(description) {
  const text = String(description || "");
  if (text.includes("雨") && text.includes("雪")) {
    return { icon: "🌨️", label: t("forecast.mixed") };
  }
  if (text.includes("雪")) return { icon: "❄️", label: t("forecast.snow") };
  if (text.includes("雨")) return { icon: "🌧️", label: t("forecast.rain") };
  if (text.includes("くもり")) return { icon: "☁️", label: t("forecast.cloudy") };
  if (text.includes("晴")) return { icon: "☀️", label: t("forecast.clear") };
  return { icon: "·", label: t("forecast.unknown") };
}

function renderForecast(forecast) {
  const container = element("forecastPeriods");
  container.replaceChildren();
  const now = Date.now();
  const periods = Array.isArray(forecast?.periods)
    ? forecast.periods.filter((period) => {
      const startsAt = new Date(period?.starts_at).getTime();
      return Number.isFinite(startsAt) && startsAt + 3 * 60 * 60 * 1000 > now;
    }).slice(0, 4)
    : [];

  if (periods.length === 0) {
    element("forecastStatus").textContent = t("forecast.unavailable");
    return;
  }

  periods.forEach((period) => {
    const startsAt = new Date(period.starts_at);
    const condition = forecastConditionInfo(period.weather);
    const item = document.createElement("div");
    item.className = "forecast-period";

    const time = document.createElement("time");
    time.dateTime = period.starts_at;
    time.textContent = formatJst(startsAt, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      hour12: false
    });
    const icon = document.createElement("span");
    icon.className = "forecast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = condition.icon;
    const value = document.createElement("strong");
    const temperature = finiteNumber(period.temperature);
    value.textContent = Number.isFinite(temperature) ? `${Math.round(temperature)}°` : "--";
    const label = document.createElement("small");
    label.textContent = condition.label;

    item.append(time, icon, value, label);
    container.append(item);
  });

  const publishedAt = new Date(forecast?.published_at);
  element("forecastStatus").textContent = !Number.isNaN(publishedAt.getTime())
    ? t("forecast.updated", {
      time: formatJst(publishedAt, { hour: "2-digit", minute: "2-digit", hour12: false })
    })
    : "JMA";
}

function renderWeather(data) {
  const current = data?.current;
  if (!current) throw new Error("Invalid weather response");
  const temperature = finiteNumber(current.temperature);
  const humidity = finiteNumber(current.humidity);
  const feelsLike = finiteNumber(current.apparent_temperature);
  const precipitation = finiteNumber(current.precipitation_10m);
  const wind = finiteNumber(current.wind_speed);
  const weather = weatherConditionInfo(data?.condition?.code);
  const observedAt = new Date(data?.observed_at);
  const observationTime = !Number.isNaN(observedAt.getTime())
    ? formatJst(observedAt, { hour: "2-digit", minute: "2-digit", hour12: false })
    : "--:--";

  element("weatherIcon").textContent = weather.icon;
  element("weatherDescription").textContent = weather.label;
  element("weatherUpdated").textContent = t(
    data?.quality?.stale ? "weather.updatedStale" : "weather.updated",
    {
      time: observationTime
    }
  );
  element("outdoorTemperature").textContent = fixed(temperature, 1);
  element("outdoorHumidity").textContent =
    Number.isFinite(humidity) ? Math.round(humidity) : "--";
  element("outdoorFeelsLike").textContent = fixed(feelsLike, 1);
  element("outdoorPrecipitation").textContent = fixed(precipitation, 1);
  element("outdoorWind").textContent = fixed(wind, 1);
  renderForecast(data.forecast);
}

function renderWeatherUnavailable() {
  element("weatherIcon").textContent = "·";
  element("weatherDescription").textContent = t("weather.unavailable");
  element("weatherUpdated").textContent = t(
    WEATHER_API_URL ? "weather.retry" : "weather.notConfigured"
  );
  element("forecastPeriods").replaceChildren();
  element("forecastStatus").textContent = t("forecast.unavailable");
}

async function refreshWeather() {
  if (document.hidden || !state.weatherEnabled) return;

  try {
    if (!WEATHER_API_URL) throw new Error("JMA Worker URL is not configured");
    const data = await fetchJson(
      WEATHER_API_URL,
      "weatherController"
    );
    state.weatherData = data;
    state.weatherStatus = "ready";
    renderWeather(data);
  } catch (error) {
    if (error.name !== "AbortError") {
      state.weatherStatus = "error";
      renderWeatherUnavailable();
    }
  }
}

function enableWeather() {
  const wasEnabled = state.weatherEnabled;
  state.weatherEnabled = true;
  if (!wasEnabled || (!state.weatherTimer && !state.weatherController)) {
    refreshWeather().finally(() => scheduleWeather());
  }
}

function renderConnection(createdAt, failed = false) {
  const connection = element("connection");
  const text = element("connectionText");

  if (failed || !(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    connection.dataset.state = "offline";
    text.textContent = t("connection.failed");
    return;
  }

  const ageMinutes = (Date.now() - createdAt.getTime()) / 60_000;
  if (ageMinutes <= 5) {
    connection.dataset.state = "online";
    text.textContent = t("connection.online");
  } else if (ageMinutes <= 15) {
    connection.dataset.state = "stale";
    text.textContent = t("connection.stale");
  } else {
    connection.dataset.state = "offline";
    text.textContent = t("connection.offline");
  }
}

function latestValidMetric(readings, metricName) {
  for (const reading of readings) {
    const value = finiteNumber(reading?.values?.[metricName]);
    const createdAt = new Date(reading?.measured_at);
    if (
      reading?.quality?.[metricName] === "valid" &&
      Number.isFinite(value) &&
      !Number.isNaN(createdAt.getTime())
    ) {
      return { value, createdAt };
    }
  }
  return { value: null, createdAt: null };
}

function buildCurrentSnapshot(data, lightData) {
  const readings = Array.isArray(data?.readings)
    ? data.readings
      .filter((reading) => reading && typeof reading === "object")
      .sort((left, right) => Date.parse(right.measured_at) - Date.parse(left.measured_at))
    : [];
  if (!readings.length) throw new Error("Invalid current response");

  const latestFeed = readings[0];
  const fields = {
    field1: latestValidMetric(readings, "air_temperature"),
    field2: latestValidMetric(readings, "humidity"),
    field3: latestValidMetric(readings, "pressure"),
    field4: latestValidMetric(readings, "wifi_rssi"),
    field5: latestValidMetric(readings, "water_temperature"),
    field6: {
      value: lightData?.telemetry?.power_state === "on" ? 1 :
        lightData?.telemetry?.power_state === "off" ? 0 : null,
      createdAt: lightData?.telemetry?.observed_at
        ? new Date(lightData.telemetry.observed_at) : null
    },
    field7: {
      value: finiteNumber(lightData?.telemetry?.power_w),
      createdAt: lightData?.telemetry?.observed_at
        ? new Date(lightData.telemetry.observed_at) : null
    },
    field8: {
      value: finiteNumber(lightData?.telemetry?.runtime_minutes),
      createdAt: lightData?.telemetry?.observed_at
        ? new Date(lightData.telemetry.observed_at) : null
    }
  };
  return { latestFeed, fields };
}

function renderMeasurementAge(id, reading) {
  const target = element(id);
  if (!target) return;
  target.textContent = reading?.createdAt instanceof Date
    ? t("status.lastMeasured", { time: relativeTime(reading.createdAt) })
    : t("status.noRecentData");
}

function renderCurrent(snapshot) {
  state.currentFeed = snapshot;
  state.currentFailed = false;
  const feed = snapshot.latestFeed;
  const fields = snapshot.fields;
  const temperature = fields.field1.value;
  const humidity = fields.field2.value;
  const pressure = fields.field3.value;
  const rssi = fields.field4.value;
  const waterTemperature = fields.field5.value;
  const lightStatus = fields.field6.value;
  const lightPower = fields.field7.value;
  const lightMinutes = fields.field8.value;
  const createdAt = new Date(feed.measured_at);

  element("temperature").textContent = fixed(temperature, 1);
  element("humidity").textContent = fixed(humidity, 1);
  element("pressure").textContent = fixed(pressure, 1);
  element("waterTemperature").textContent = fixed(waterTemperature, 1);
  element("temperatureNote").textContent = temperatureDescription(temperature);
  element("humidityNote").textContent = humidityDescription(humidity);
  renderDerivedMetrics(temperature, humidity);
  element("wifiRssi").textContent = Number.isFinite(rssi) ? `${Math.round(rssi)} dBm` : "-- dBm";
  element("wifiQuality").textContent = wifiDescription(rssi);
  const readingSequence = String(feed.reading_id || "").split(":").at(-1);
  element("entryId").textContent = readingSequence ? `#${readingSequence}` : "#--";
  element("lightPower").textContent = fixed(lightPower, 1);
  element("lightRuntime").textContent = formatRuntime(lightMinutes);

  renderMeasurementAge("airUpdated", fields.field1);
  renderMeasurementAge("waterUpdated", fields.field5);
  renderMeasurementAge("lightUpdated", fields.field6);

  const lightOn = lightStatus === 1;
  const lightKnown = lightStatus === 0 || lightStatus === 1;
  element("lightIcon").classList.toggle("on", lightOn);
  element("lightState").textContent = lightKnown
    ? (lightOn ? t("light.on") : t("light.off"))
    : t("light.unknown");
  element("lightCaption").textContent = lightKnown
    ? (lightOn ? t("light.running") : t("light.waiting"))
    : t("light.noData");

  if (!Number.isNaN(createdAt.getTime())) {
    const absolute = formatJst(createdAt, {
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    element("updatedAt").textContent = `${absolute} · ${relativeTime(createdAt)}`;
  } else {
    element("updatedAt").textContent = t("current.timeUnavailable");
  }

  renderConnection(createdAt);
}

async function refreshCurrent() {
  if (document.hidden) return;
  const sequence = ++state.currentSequence;
  try {
    const [data, lightData] = await Promise.all([
      fetchJson(
        dataApiUrl(
          `/v1/readings?days=1&limit=${CURRENT_LOOKBACK_RESULTS}` +
          `&device_id=esp32-01&metrics=${DASHBOARD_METRICS.join(",")}`
        ),
        "currentController"
      ),
      fetch(dataApiUrl("/v1/light/current"), { cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null)
    ]);
    if (sequence !== state.currentSequence) return;
    renderCurrent(buildCurrentSnapshot(data, lightData));
  } catch (error) {
    if (sequence !== state.currentSequence || error.name === "AbortError") return;
    state.currentFailed = true;
    renderConnection(null, true);
    element("updatedAt").textContent = t("current.loadFailed");
  }
}

function parseRawHistory(readings) {
  return readings
    .map((reading) => ({
      time: Date.parse(reading.measured_at),
      temperature: finiteNumber(reading.values?.air_temperature),
      humidity: finiteNumber(reading.values?.humidity),
      pressure: finiteNumber(reading.values?.pressure),
      waterTemperature: finiteNumber(reading.values?.water_temperature)
    }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);
}

function parseAggregateHistory(buckets) {
  return buckets
    .map((bucket) => ({
      time: Date.parse(bucket.start),
      temperature: finiteNumber(bucket.metrics?.air_temperature?.mean),
      humidity: finiteNumber(bucket.metrics?.humidity?.mean),
      pressure: finiteNumber(bucket.metrics?.pressure?.mean),
      waterTemperature: finiteNumber(bucket.metrics?.water_temperature?.mean)
    }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);
}

function historyWindowQuery(config, window) {
  if (!window) return config.query;
  const parameters = new URLSearchParams({
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    device_id: "esp32-01"
  });
  if (config.paginated) parameters.set("limit", "1000");
  return parameters.toString();
}

function lightHistoryQuery(range, window) {
  const parameters = new URLSearchParams({
    granularity: range === "day" ? "raw" : "hourly"
  });
  if (window) {
    parameters.set("from", new Date(window.from).toISOString());
    parameters.set("to", new Date(window.to).toISOString());
  } else {
    parameters.set("days", String(range === "month" ? 30 : range === "week" ? 7 : 2));
  }
  return parameters.toString();
}

async function fetchHistoryPoints(config, range, window = null) {
  const metrics = `metrics=${HISTORY_METRICS.join(",")}`;
  const lightPromise = fetch(dataApiUrl(
    `/v1/light/history?${lightHistoryQuery(range, window)}`
  ), { cache: "no-store" })
    .then((response) => response.ok ? response.json() : { points: [] })
    .then((data) => (Array.isArray(data?.points) ? data.points : []).map((point) => ({
      time: Date.parse(point.time),
      lightStatus: finiteNumber(point.light_status)
    })).filter((point) => Number.isFinite(point.time)))
    .catch(() => []);
  if (!config.paginated) {
    const data = await fetchJson(
      dataApiUrl(`${config.endpoint}?${historyWindowQuery(config, window)}&${metrics}`),
      "historyController"
    );
    return {
      sensorPoints: parseAggregateHistory(Array.isArray(data?.buckets) ? data.buckets : []),
      lightPoints: await lightPromise
    };
  }

  const readings = [];
  let cursor = null;
  for (let page = 0; page < 4; page += 1) {
    const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await fetchJson(
      dataApiUrl(
        `${config.endpoint}?${historyWindowQuery(config, window)}&${metrics}${cursorQuery}`
      ),
      "historyController"
    );
    if (Array.isArray(data?.readings)) readings.push(...data.readings);
    cursor = data?.page?.next_cursor || null;
    if (!cursor) return { sensorPoints: parseRawHistory(readings), lightPoints: await lightPromise };
  }
  throw new Error("History pagination exceeded the safety limit");
}

function mergeTimeSeries(current, incoming, earliest, end) {
  const pointsByTime = new Map();
  current.forEach((point) => pointsByTime.set(point.time, point));
  incoming.forEach((point) => pointsByTime.set(point.time, point));
  return [...pointsByTime.values()]
    .filter((point) => point.time >= earliest && point.time <= end)
    .sort((left, right) => left.time - right.time);
}

function incrementalHistoryWindow(range, domain) {
  if (!state.history.length || !state.lightHistory.length) return null;
  if (Date.now() - state.historyFullRefreshAt >= HISTORY_FULL_REFRESH_MS) return null;

  const latestSensorTime = state.history[state.history.length - 1]?.time;
  const latestLightTime = state.lightHistory[state.lightHistory.length - 1]?.time;
  if (!Number.isFinite(latestSensorTime) || !Number.isFinite(latestLightTime)) return null;

  const earliest = range === "day" ? domain.previousStart : domain.start;
  const overlap = range === "day" ? RAW_HISTORY_OVERLAP_MS : AGGREGATE_HISTORY_OVERLAP_MS;
  return {
    from: Math.max(earliest, Math.min(latestSensorTime, latestLightTime) - overlap),
    to: Date.now() + 60_000
  };
}

function setRangeButtons(activeRange, disabled = false) {
  document.querySelectorAll(".range-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === activeRange);
    button.disabled = disabled;
  });
}

function renderHistoryStatus() {
  const range = state.historyStatus === "loading"
    ? state.historyTargetRange
    : state.range;
  const config = RANGE_CONFIG[range] || RANGE_CONFIG.day;
  if (state.historyStatus === "loading") {
    element("historyStatus").textContent = t("history.loadingRange", {
      range: t(config.labelKey)
    });
    return;
  }
  if (state.historyStatus === "error") {
    element("historyStatus").textContent = t("history.loadFailed");
    element("historyResolution").textContent = t("history.retry");
    return;
  }
  element("historyStatus").textContent = t("history.ready", {
    range: t(config.labelKey),
    count: state.history.length.toLocaleString(locale())
  });
  element("historyResolution").textContent = t(config.resolutionKey);
}

async function loadHistory(range, announceLoading = true, preferIncremental = false) {
  if (document.hidden) return;
  const config = RANGE_CONFIG[range] || RANGE_CONFIG.day;
  const sequence = ++state.historySequence;
  const domain = historyDomain(range);
  const window = preferIncremental && state.range === range
    ? incrementalHistoryWindow(range, domain)
    : null;

  if (announceLoading) {
    state.historyStatus = "loading";
    state.historyTargetRange = range;
    renderHistoryStatus();
    setRangeButtons(state.range, true);
  }

  try {
    const { sensorPoints: points, lightPoints } = await fetchHistoryPoints(config, range, window);
    if (sequence !== state.historySequence) return;
    enableWeather();
    const earliest = range === "day" ? domain.previousStart : domain.start;
    const visiblePoints = window
      ? mergeTimeSeries(state.history, points, earliest, domain.end)
      : points.filter((point) => point.time >= earliest && point.time <= domain.end);
    const visibleLightPoints = window
      ? mergeTimeSeries(state.lightHistory, lightPoints, earliest, domain.end)
      : lightPoints
        .filter((point) => point.time >= earliest && point.time <= domain.end)
        .sort((left, right) => left.time - right.time);
    state.range = range;
    state.historyTargetRange = range;
    state.history = visiblePoints;
    state.lightHistory = visibleLightPoints;
    if (!window) state.historyFullRefreshAt = Date.now();
    state.historyStatus = "ready";
    state.rangeStart = domain.start;
    state.rangeEnd = domain.end;
    state.previousStart = domain.previousStart;
    state.todayStart = domain.todayStart;
    setRangeButtons(range, false);
    element("comparisonLegend").hidden = range !== "day";
    renderHistoryStatus();
    renderLightTimeline();
    updateChartSummaries();
    drawAllCharts();
  } catch (error) {
    if (sequence !== state.historySequence || error.name === "AbortError") return;
    if (window && state.history.length) {
      state.historyStatus = "ready";
      setRangeButtons(state.range, false);
      renderHistoryStatus();
      return;
    }
    state.historyStatus = "error";
    setRangeButtons(state.range, false);
    renderHistoryStatus();
  }
}

function lightSegments(points = state.lightHistory) {
  if (points.length < 2) return [];
  const config = RANGE_CONFIG[state.range] || RANGE_CONFIG.day;
  const maximumGap = config.bucketSeconds * 3 * 1000;
  const segments = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const duration = next.time - current.time;
    if (
      !Number.isFinite(current.lightStatus) ||
      current.lightStatus <= 0 ||
      duration <= 0 ||
      duration > maximumGap
    ) {
      continue;
    }

    const intensity = Math.min(1, Math.max(0, current.lightStatus));
    const previous = segments[segments.length - 1];
    if (
      previous &&
      current.time - previous.end <= config.bucketSeconds * 1000 * 1.1 &&
      Math.abs(previous.intensity - intensity) < 0.08
    ) {
      previous.end = next.time;
      previous.weightedDuration += duration * intensity;
      previous.duration += duration;
      previous.intensity = previous.weightedDuration / previous.duration;
    } else {
      segments.push({
        start: current.time,
        end: next.time,
        intensity,
        weightedDuration: duration * intensity,
        duration
      });
    }
  }

  return segments;
}

function timelineLabel(timestamp) {
  return formatJst(new Date(timestamp), { month: "numeric", day: "numeric" });
}

function renderTimelineSegments(container, segments, start, end) {
  container.replaceChildren();
  const span = Math.max(1, end - start);
  let runtime = 0;

  segments.forEach((segment) => {
    const visibleStart = Math.max(start, segment.start);
    const visibleEnd = Math.min(end, segment.end);
    if (visibleEnd <= visibleStart) return;
    const bar = document.createElement("span");
    const left = ((visibleStart - start) / span) * 100;
    const width = ((visibleEnd - visibleStart) / span) * 100;
    bar.className = "light-timeline-segment";
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(0.12, width)}%`;
    bar.style.opacity = `${0.38 + segment.intensity * 0.62}`;
    container.appendChild(bar);
    runtime += segment.weightedDuration;
  });

  return runtime;
}

function renderLightTimeline() {
  const container = element("lightTimelineSegments");
  const previousContainer = element("previousLightTimelineSegments");
  const previousRow = element("previousLightRow");
  const currentRowLabel = element("currentLightRowLabel");
  const summary = element("lightTimelineSummary");
  const startLabel = element("lightTimelineStart");
  const endLabel = element("lightTimelineEnd");
  container.replaceChildren();
  previousContainer.replaceChildren();

  if (state.lightHistory.length < 2) {
    summary.textContent = t("common.noData");
    startLabel.textContent = "--";
    endLabel.textContent = "--";
    return;
  }

  if (state.range === "day") {
    const previousPoints = state.lightHistory.filter(
      (point) => point.time >= state.previousStart && point.time < state.todayStart
    );
    const todayPoints = state.lightHistory.filter(
      (point) => point.time >= state.todayStart && point.time < state.rangeEnd
    );
    const previousSegments = lightSegments(previousPoints);
    const todaySegments = lightSegments(todayPoints);
    const previousRuntime = renderTimelineSegments(
      previousContainer,
      previousSegments,
      state.previousStart,
      state.todayStart
    );
    const todayRuntime = renderTimelineSegments(
      container,
      todaySegments,
      state.todayStart,
      state.rangeEnd
    );

    previousRow.hidden = false;
    currentRowLabel.textContent = t("common.today");
    summary.textContent = previousSegments.length || todaySegments.length
      ? t("timeline.daySummary", {
        today: formatRuntime(todayRuntime / 60_000),
        previous: formatRuntime(previousRuntime / 60_000)
      })
      : t("timeline.noOnRecord");
    startLabel.textContent = "00:00";
    endLabel.textContent = "24:00";
    return;
  }

  previousRow.hidden = true;
  currentRowLabel.textContent = t("timeline.light");
  const segments = lightSegments();
  const runtime = renderTimelineSegments(
    container,
    segments,
    state.rangeStart,
    state.rangeEnd
  );
  summary.textContent = segments.length
    ? t("timeline.rangeSummary", { runtime: formatRuntime(runtime / 60_000) })
    : t("timeline.noOnRecord");
  startLabel.textContent = timelineLabel(state.rangeStart);
  endLabel.textContent = timelineLabel(state.rangeEnd);
}

function chartValues(field) {
  return state.history.filter((point) => Number.isFinite(point[field]));
}

function chartStats(field) {
  const values = chartValues(field)
    .filter((point) => state.range !== "day" || point.time >= state.todayStart)
    .map((point) => point[field]);
  if (!values.length) return null;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { minimum, maximum, average };
}

function updateChartSummaries() {
  Object.values(CHART_CONFIG).forEach((config) => {
    const stats = chartStats(config.field);
    if (!stats) {
      element(config.summaryId).textContent = "--";
      element(config.statsId).textContent = t("common.noData");
      return;
    }
    element(config.summaryId).textContent = t("chart.average", {
      value: fixed(stats.average, config.decimals),
      unit: config.unit
    });
    element(config.statsId).textContent = t("chart.stats", {
      minimum: fixed(stats.minimum, config.decimals),
      maximum: fixed(stats.maximum, config.decimals)
    });
  });
}

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function colorWithAlpha(color, alpha) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  const normalized = context.fillStyle;
  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const number = Number.parseInt(full, 16);
    return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
  }
  return color;
}

function niceBounds(values, config) {
  if (!values.length) return [0, config.minimumSpan];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const rawSpan = maximum - minimum;
  const paddedSpan = Math.max(config.minimumSpan, rawSpan * 1.24);
  const center = (minimum + maximum) / 2;
  let low = Math.floor((center - paddedSpan / 2) / config.step) * config.step;
  let high = Math.ceil((center + paddedSpan / 2) / config.step) * config.step;
  if (high - low < config.minimumSpan) high = low + config.minimumSpan;
  if (config.field === "humidity") {
    low = Math.max(0, low);
    high = Math.min(100, high);
  }
  return [low, high];
}

function chartSeries(field) {
  const points = chartValues(field);
  if (state.range !== "day") {
    return [{
      key: "current",
      label: "",
      points: points.map((point) => ({ ...point, plotTime: point.time }))
    }];
  }

  return [
    {
      key: "previous",
      label: t("common.previousDay"),
      points: points
        .filter((point) => point.time >= state.previousStart && point.time < state.todayStart)
        .map((point) => ({ ...point, plotTime: point.time + DAY_MS }))
    },
    {
      key: "today",
      label: t("common.today"),
      points: points
        .filter((point) => point.time >= state.todayStart && point.time < state.rangeEnd)
        .map((point) => ({ ...point, plotTime: point.time }))
    }
  ];
}

function xAxisLabel(timestamp) {
  if (state.range === "day") {
    const hours = Math.round((timestamp - state.rangeStart) / (60 * 60 * 1000));
    return `${hours}:00`;
  }
  return formatJst(new Date(timestamp), { month: "numeric", day: "numeric" });
}

function tooltipTime(timestamp) {
  return formatJst(new Date(timestamp), {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function splitCoordinateGroups(coordinates, maximumGapMs) {
  const groups = [];
  let current = [];

  coordinates.forEach((coordinate) => {
    const previous = current[current.length - 1];
    if (previous && coordinate.point.time - previous.point.time > maximumGapMs) {
      groups.push(current);
      current = [];
    }
    current.push(coordinate);
  });

  if (current.length) groups.push(current);
  return groups;
}

class LineChart {
  constructor(config) {
    this.config = config;
    this.canvas = element(config.canvasId);
    this.tooltip = element(config.tooltipId);
    this.plot = null;
    this.points = [];
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerleave", () => this.hideTooltip());
  }

  draw() {
    const bounds = this.canvas.getBoundingClientRect();
    const width = bounds.width;
    const height = bounds.height;
    if (width <= 0 || height <= 0) return;

    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));

    const context = this.canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const margin = {
      left: width < 480 ? 43 : 50,
      right: 12,
      top: 9,
      bottom: 29
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const series = chartSeries(this.config.field);
    const points = series.flatMap((item) => item.points);
    const values = points.map((point) => point[this.config.field]);

    if (!points.length || plotWidth <= 0 || plotHeight <= 0) {
      context.fillStyle = cssValue("--faint");
      context.font = "12px system-ui";
      context.textAlign = "center";
      context.fillText(t("chart.noData"), width / 2, height / 2);
      this.plot = null;
      this.points = [];
      return;
    }

    const firstTime = state.rangeStart || Math.min(...points.map((point) => point.plotTime));
    const lastTime = state.rangeEnd || Math.max(...points.map((point) => point.plotTime));
    const timeSpan = Math.max(1, lastTime - firstTime);
    const [minimum, maximum] = niceBounds(values, this.config);
    const valueSpan = Math.max(0.0001, maximum - minimum);
    const lineColor = cssValue(this.config.cssColor);
    const gridColor = cssValue("--grid");
    const mutedColor = cssValue("--faint");
    const lightColor = cssValue("--light");

    const xFor = (timestamp) => margin.left + ((timestamp - firstTime) / timeSpan) * plotWidth;
    const yFor = (value) => margin.top + ((maximum - value) / valueSpan) * plotHeight;

    const shadedLightPoints = state.range === "day"
      ? state.lightHistory.filter(
        (point) => point.time >= state.todayStart && point.time < state.rangeEnd
      )
      : state.lightHistory;
    lightSegments(shadedLightPoints).forEach((segment) => {
      const start = Math.max(firstTime, segment.start);
      const end = Math.min(lastTime, segment.end);
      if (end <= start) return;
      const left = xFor(start);
      const right = xFor(end);
      context.fillStyle = colorWithAlpha(lightColor, 0.055 + segment.intensity * 0.095);
      context.fillRect(left, margin.top, Math.max(1, right - left), plotHeight);
    });

    context.lineWidth = 1;
    context.strokeStyle = gridColor;
    context.fillStyle = mutedColor;
    context.font = "11px system-ui";

    for (let index = 0; index <= 4; index += 1) {
      const y = margin.top + (plotHeight * index) / 4;
      context.beginPath();
      context.moveTo(margin.left, y);
      context.lineTo(width - margin.right, y);
      context.stroke();
      context.textAlign = "right";
      context.textBaseline = "middle";
      const value = maximum - (valueSpan * index) / 4;
      context.fillText(value.toFixed(this.config.decimals), margin.left - 7, y);
    }

    const tickCount = width < 480 ? 3 : 5;
    for (let index = 0; index <= tickCount; index += 1) {
      const x = margin.left + (plotWidth * index) / tickCount;
      const timestamp = firstTime + (timeSpan * index) / tickCount;
      context.textAlign = index === 0 ? "left" : (index === tickCount ? "right" : "center");
      context.textBaseline = "top";
      context.fillText(xAxisLabel(timestamp), x, margin.top + plotHeight + 9);
    }

    const gradient = context.createLinearGradient(0, margin.top, 0, margin.top + plotHeight);
    gradient.addColorStop(0, colorWithAlpha(lineColor, 0.20));
    gradient.addColorStop(1, colorWithAlpha(lineColor, 0.015));

    const rangeConfig = RANGE_CONFIG[state.range] || RANGE_CONFIG.day;
    context.lineJoin = "round";
    context.lineCap = "round";
    const allCoordinates = [];
    const renderedSeries = series.map((item) => {
      const coordinates = item.points.map((point) => ({
        x: xFor(point.plotTime),
        y: yFor(point[this.config.field]),
        point,
        seriesKey: item.key,
        seriesLabel: item.label
      }));
      return {
        ...item,
        coordinates,
        groups: splitCoordinateGroups(
          coordinates,
          rangeConfig.bucketSeconds * 3 * 1000
        )
      };
    });

    renderedSeries.forEach((item) => {
      if (item.key !== "previous") {
        item.groups.forEach((group) => {
          if (group.length < 2) return;
          context.beginPath();
          group.forEach((coordinate, index) => {
            if (index === 0) context.moveTo(coordinate.x, coordinate.y);
            else context.lineTo(coordinate.x, coordinate.y);
          });
          context.lineTo(group[group.length - 1].x, margin.top + plotHeight);
          context.lineTo(group[0].x, margin.top + plotHeight);
          context.closePath();
          context.fillStyle = gradient;
          context.fill();
        });
      }

      context.setLineDash(item.key === "previous" ? [5, 5] : []);
      context.strokeStyle = item.key === "previous"
        ? colorWithAlpha(lineColor, 0.48)
        : lineColor;
      context.fillStyle = context.strokeStyle;
      context.lineWidth = item.key === "previous" ? 1.6 : 2;
      item.groups.forEach((group) => {
        if (group.length === 1) {
          context.beginPath();
          context.arc(group[0].x, group[0].y, 2.1, 0, Math.PI * 2);
          context.fill();
          return;
        }
        context.beginPath();
        group.forEach((coordinate, index) => {
          if (index === 0) context.moveTo(coordinate.x, coordinate.y);
          else context.lineTo(coordinate.x, coordinate.y);
        });
        context.stroke();
      });
      allCoordinates.push(...item.coordinates);
    });
    context.setLineDash([]);

    const currentSeries = renderedSeries.find((item) => item.key !== "previous" && item.coordinates.length);
    if (currentSeries) {
      const latest = currentSeries.coordinates[currentSeries.coordinates.length - 1];
      context.beginPath();
      context.arc(latest.x, latest.y, 3.2, 0, Math.PI * 2);
      context.fillStyle = lineColor;
      context.fill();
    }

    this.plot = { margin, plotWidth, plotHeight, width, height };
    this.points = allCoordinates;
  }

  onPointerMove(event) {
    if (!this.plot || !this.points.length) return;
    const bounds = this.canvas.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    if (pointerX < this.plot.margin.left || pointerX > this.plot.width - this.plot.margin.right) {
      this.hideTooltip();
      return;
    }

    let nearest = this.points[0];
    let distance = Math.abs(pointerX - nearest.x) + Math.abs(pointerY - nearest.y) * 0.2;
    for (let index = 1; index < this.points.length; index += 1) {
      const candidateDistance =
        Math.abs(pointerX - this.points[index].x) +
        Math.abs(pointerY - this.points[index].y) * 0.2;
      if (candidateDistance < distance) {
        distance = candidateDistance;
        nearest = this.points[index];
      }
    }

    const value = nearest.point[this.config.field];
    const seriesText = nearest.seriesLabel ? `${nearest.seriesLabel} · ` : "";
    this.tooltip.innerHTML =
      `<strong>${fixed(value, this.config.decimals)} ${this.config.unit}</strong>` +
      `<span>${seriesText}${tooltipTime(nearest.point.time)}</span>`;
    this.tooltip.hidden = false;

    const tooltipWidth = this.tooltip.offsetWidth;
    const half = tooltipWidth / 2;
    const clampedX = Math.max(half + 5, Math.min(this.plot.width - half - 5, nearest.x));
    const preferredY = Math.max(48, Math.min(this.plot.height - 12, nearest.y));
    this.tooltip.style.left = `${clampedX}px`;
    this.tooltip.style.top = `${preferredY}px`;

    if (event.pointerType === "touch") event.preventDefault();
  }

  hideTooltip() {
    this.tooltip.hidden = true;
  }
}

function drawAllCharts() {
  Object.values(state.charts).forEach((chart) => chart.draw());
}

function scheduleCurrent(delay = CURRENT_REFRESH_MS) {
  clearTimeout(state.currentTimer);
  if (!document.hidden) state.currentTimer = setTimeout(runCurrentLoop, delay);
}

function scheduleHistory(delay = HISTORY_REFRESH_MS) {
  clearTimeout(state.historyTimer);
  if (!document.hidden) state.historyTimer = setTimeout(runHistoryLoop, delay);
}

function scheduleWeather(delay = WEATHER_REFRESH_MS) {
  clearTimeout(state.weatherTimer);
  if (!document.hidden && state.weatherEnabled) {
    state.weatherTimer = setTimeout(runWeatherLoop, delay);
  }
}

async function runCurrentLoop() {
  await refreshCurrent();
  scheduleCurrent();
}

async function runHistoryLoop() {
  await loadHistory(state.range, false, true);
  scheduleHistory();
}

async function runWeatherLoop() {
  await refreshWeather();
  scheduleWeather();
}

function stopPolling() {
  clearTimeout(state.currentTimer);
  clearTimeout(state.historyTimer);
  clearTimeout(state.weatherTimer);
  state.currentTimer = 0;
  state.historyTimer = 0;
  state.weatherTimer = 0;
  if (state.currentController) state.currentController.abort();
  if (state.historyController) state.historyController.abort();
  if (state.weatherController) state.weatherController.abort();
}

function startPolling() {
  refreshCurrent().finally(() => scheduleCurrent());
  loadHistory(state.range, state.historyStatus !== "ready", true)
    .finally(() => scheduleHistory());
  if (state.weatherEnabled) {
    refreshWeather().finally(() => scheduleWeather());
  }
}

function translateStaticContent() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-i18n-content]").forEach((node) => {
    node.setAttribute("content", t(node.dataset.i18nContent));
  });
}

function setLanguage(language, persist = true) {
  state.language = language === "ja" ? "ja" : "ko";
  document.documentElement.lang = state.language;
  translateStaticContent();

  document.querySelectorAll(".language-button").forEach((button) => {
    const active = button.dataset.language === state.language;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
    } catch {
      // The dashboard still works when browser storage is unavailable.
    }
  }

  const currentWasFailed = state.currentFailed;
  if (state.currentFeed) {
    renderCurrent(state.currentFeed);
  }
  if (currentWasFailed) {
    state.currentFailed = true;
    renderConnection(null, true);
    element("updatedAt").textContent = t("current.loadFailed");
  }

  if (state.weatherStatus === "ready" && state.weatherData) {
    renderWeather(state.weatherData);
  } else if (state.weatherStatus === "error") {
    renderWeatherUnavailable();
  }

  renderHistoryStatus();
  renderLightTimeline();
  updateChartSummaries();
  drawAllCharts();
}

document.querySelectorAll(".language-button").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.language === state.language) return;
    setLanguage(button.dataset.language);
  });
});

document.querySelectorAll(".range-button").forEach((button) => {
  button.addEventListener("click", () => {
    const range = button.dataset.range;
    if (!RANGE_CONFIG[range] || range === state.range) return;
    loadHistory(range).finally(() => scheduleHistory());
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else startPolling();
});

window.addEventListener("resize", () => {
  cancelAnimationFrame(state.resizeFrame);
  state.resizeFrame = requestAnimationFrame(drawAllCharts);
});

const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
if (typeof colorScheme.addEventListener === "function") {
  colorScheme.addEventListener("change", drawAllCharts);
}

Object.entries(CHART_CONFIG).forEach(([name, config]) => {
  state.charts[name] = new LineChart(config);
});

setLanguage(state.language, false);
startPolling();
