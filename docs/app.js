"use strict";

const CHANNEL_ID = 3436358;
const API_BASE = `https://api.thingspeak.com/channels/${CHANNEL_ID}`;
const CURRENT_REFRESH_MS = 15_000;
const HISTORY_REFRESH_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const JST_TIME_ZONE = "Asia/Tokyo";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_CONFIG = {
  day: {
    query: "days=2",
    resolution: "2분 원본 데이터",
    label: "오늘과 전날",
    bucketSeconds: 120
  },
  week: {
    query: "days=7&average=10",
    resolution: "10분 평균",
    label: "최근 7일",
    bucketSeconds: 600
  },
  month: {
    query: "days=30&average=60",
    resolution: "1시간 평균",
    label: "최근 30일",
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
  }
};

const state = {
  range: "day",
  history: [],
  historySequence: 0,
  currentSequence: 0,
  historyController: null,
  currentController: null,
  currentTimer: 0,
  historyTimer: 0,
  resizeFrame: 0,
  rangeStart: 0,
  rangeEnd: 1,
  previousStart: 0,
  todayStart: 0,
  charts: {}
};

const element = (id) => document.getElementById(id);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fixed(value, decimals = 1) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "--";
}

function formatRuntime(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "--";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (hours === 0) return `${remainder}분`;
  if (remainder === 0) return `${hours}시간`;
  return `${hours}시간 ${remainder}분`;
}

function formatJst(date, options) {
  return new Intl.DateTimeFormat("ko-KR", {
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
  if (seconds < 10) return "방금 전";
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function temperatureDescription(value) {
  if (!Number.isFinite(value)) return "측정 대기 중";
  if (value < 15) return "다소 낮은 온도";
  if (value > 32) return "높은 온도";
  return "안정적인 범위";
}

function humidityDescription(value) {
  if (!Number.isFinite(value)) return "측정 대기 중";
  if (value < 35) return "건조한 환경";
  if (value > 75) return "습도가 높은 환경";
  return "안정적인 범위";
}

function discomfortDescription(value) {
  if (!Number.isFinite(value)) return "계산 대기 중";
  if (value < 68) return "대체로 쾌적";
  if (value < 75) return "보통";
  if (value < 80) return "약간 불쾌";
  return "불쾌감 높음";
}

function vpdDescription(value) {
  if (!Number.isFinite(value)) return "계산 대기 중";
  if (value < 0.4) return "증산이 낮은 범위";
  if (value > 1.6) return "증산이 높은 범위";
  return "균형적인 참고 범위";
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
    element("discomfortNote").textContent = "계산 대기 중";
    element("vpdNote").textContent = "식물 증산 참고값";
    element("dewPointNote").textContent = "결로 참고값";
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
    condensationGap <= 2 ? "결로에 가까운 상태" : `현재 온도보다 ${fixed(condensationGap, 1)}°C 낮음`;
}

function wifiDescription(rssi) {
  if (!Number.isFinite(rssi)) return "확인 불가";
  if (rssi >= -50) return "매우 좋음";
  if (rssi >= -60) return "좋음";
  if (rssi >= -70) return "보통";
  return "약함";
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

function renderConnection(createdAt, failed = false) {
  const connection = element("connection");
  const text = element("connectionText");

  if (failed || !(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    connection.dataset.state = "offline";
    text.textContent = "데이터 연결 실패";
    return;
  }

  const ageMinutes = (Date.now() - createdAt.getTime()) / 60_000;
  if (ageMinutes <= 5) {
    connection.dataset.state = "online";
    text.textContent = "정상 수신 중";
  } else if (ageMinutes <= 15) {
    connection.dataset.state = "stale";
    text.textContent = "데이터 지연";
  } else {
    connection.dataset.state = "offline";
    text.textContent = "장치 오프라인";
  }
}

function renderCurrent(feed) {
  const temperature = finiteNumber(feed.field1);
  const humidity = finiteNumber(feed.field2);
  const pressure = finiteNumber(feed.field3);
  const rssi = finiteNumber(feed.field4);
  const lightStatus = finiteNumber(feed.field6);
  const lightPower = finiteNumber(feed.field7);
  const lightMinutes = finiteNumber(feed.field8);
  const createdAt = new Date(feed.created_at);

  element("temperature").textContent = fixed(temperature, 1);
  element("humidity").textContent = fixed(humidity, 1);
  element("pressure").textContent = fixed(pressure, 1);
  element("temperatureNote").textContent = temperatureDescription(temperature);
  element("humidityNote").textContent = humidityDescription(humidity);
  renderDerivedMetrics(temperature, humidity);
  element("wifiRssi").textContent = Number.isFinite(rssi) ? `${Math.round(rssi)} dBm` : "-- dBm";
  element("wifiQuality").textContent = wifiDescription(rssi);
  element("entryId").textContent = feed.entry_id ? `#${feed.entry_id}` : "#--";
  element("lightPower").textContent = fixed(lightPower, 1);
  element("lightRuntime").textContent = formatRuntime(lightMinutes);

  const lightOn = lightStatus === 1;
  const lightKnown = lightStatus === 0 || lightStatus === 1;
  element("lightIcon").classList.toggle("on", lightOn);
  element("lightState").textContent = lightKnown ? (lightOn ? "켜짐" : "꺼짐") : "상태 확인 불가";
  element("lightCaption").textContent = lightKnown
    ? (lightOn ? "재배 조명이 작동 중입니다." : "재배 조명이 대기 중입니다.")
    : "SwitchBot 데이터가 없습니다.";

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
    element("updatedAt").textContent = "수신 시각 확인 불가";
  }

  renderConnection(createdAt);
}

async function refreshCurrent() {
  if (document.hidden) return;
  const sequence = ++state.currentSequence;
  try {
    const feed = await fetchJson(`${API_BASE}/feeds/last.json`, "currentController");
    if (sequence !== state.currentSequence) return;
    renderCurrent(feed);
  } catch (error) {
    if (sequence !== state.currentSequence || error.name === "AbortError") return;
    renderConnection(null, true);
    element("updatedAt").textContent = "최근 데이터를 불러오지 못했습니다.";
  }
}

function parseHistory(feeds) {
  return feeds
    .map((feed) => ({
      time: Date.parse(feed.created_at),
      temperature: finiteNumber(feed.field1),
      humidity: finiteNumber(feed.field2),
      pressure: finiteNumber(feed.field3),
      lightStatus: finiteNumber(feed.field6)
    }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);
}

function setRangeButtons(activeRange, disabled = false) {
  document.querySelectorAll(".range-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === activeRange);
    button.disabled = disabled;
  });
}

async function loadHistory(range, announceLoading = true) {
  if (document.hidden) return;
  const config = RANGE_CONFIG[range] || RANGE_CONFIG.day;
  const sequence = ++state.historySequence;

  if (announceLoading) {
    element("historyStatus").textContent = `${config.label} 데이터 불러오는 중…`;
    setRangeButtons(state.range, true);
  }

  try {
    const data = await fetchJson(`${API_BASE}/feeds.json?${config.query}`, "historyController");
    if (sequence !== state.historySequence) return;
    const domain = historyDomain(range);
    const earliest = range === "day" ? domain.previousStart : domain.start;
    const points = parseHistory(Array.isArray(data.feeds) ? data.feeds : [])
      .filter((point) => point.time >= earliest && point.time <= domain.end);
    state.range = range;
    state.history = points;
    state.rangeStart = domain.start;
    state.rangeEnd = domain.end;
    state.previousStart = domain.previousStart;
    state.todayStart = domain.todayStart;
    setRangeButtons(range, false);
    element("comparisonLegend").hidden = range !== "day";
    element("historyStatus").textContent = `${config.label} · ${points.length.toLocaleString("ko-KR")}개 데이터`;
    element("historyResolution").textContent = config.resolution;
    renderLightTimeline();
    updateChartSummaries();
    drawAllCharts();
  } catch (error) {
    if (sequence !== state.historySequence || error.name === "AbortError") return;
    setRangeButtons(state.range, false);
    element("historyStatus").textContent = "그래프 데이터를 불러오지 못했습니다.";
    element("historyResolution").textContent = "잠시 후 자동으로 다시 시도합니다.";
  }
}

function lightSegments(points = state.history) {
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

  if (state.history.length < 2) {
    summary.textContent = "표시할 데이터 없음";
    startLabel.textContent = "--";
    endLabel.textContent = "--";
    return;
  }

  if (state.range === "day") {
    const previousPoints = state.history.filter(
      (point) => point.time >= state.previousStart && point.time < state.todayStart
    );
    const todayPoints = state.history.filter(
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
    currentRowLabel.textContent = "오늘";
    summary.textContent = previousSegments.length || todaySegments.length
      ? `오늘 ${formatRuntime(todayRuntime / 60_000)} · 전날 ${formatRuntime(previousRuntime / 60_000)}`
      : "ON 구간 기록 없음";
    startLabel.textContent = "00:00";
    endLabel.textContent = "24:00";
    return;
  }

  previousRow.hidden = true;
  currentRowLabel.textContent = "조명";
  const segments = lightSegments();
  const runtime = renderTimelineSegments(
    container,
    segments,
    state.rangeStart,
    state.rangeEnd
  );
  summary.textContent = segments.length
    ? `표시 구간 약 ${formatRuntime(runtime / 60_000)}`
    : "ON 구간 기록 없음";
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
      element(config.statsId).textContent = "표시할 데이터 없음";
      return;
    }
    element(config.summaryId).textContent = `평균 ${fixed(stats.average, config.decimals)} ${config.unit}`;
    element(config.statsId).textContent =
      `최저 ${fixed(stats.minimum, config.decimals)} · 최고 ${fixed(stats.maximum, config.decimals)}`;
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
      label: "전날",
      points: points
        .filter((point) => point.time >= state.previousStart && point.time < state.todayStart)
        .map((point) => ({ ...point, plotTime: point.time + DAY_MS }))
    },
    {
      key: "today",
      label: "오늘",
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
      context.fillText("표시할 데이터가 없습니다.", width / 2, height / 2);
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
      ? state.history.filter(
        (point) => point.time >= state.todayStart && point.time < state.rangeEnd
      )
      : state.history;
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

async function runCurrentLoop() {
  await refreshCurrent();
  scheduleCurrent();
}

async function runHistoryLoop() {
  await loadHistory(state.range, false);
  scheduleHistory();
}

function stopPolling() {
  clearTimeout(state.currentTimer);
  clearTimeout(state.historyTimer);
  state.currentTimer = 0;
  state.historyTimer = 0;
  if (state.currentController) state.currentController.abort();
  if (state.historyController) state.historyController.abort();
}

function startPolling() {
  refreshCurrent().finally(() => scheduleCurrent());
  loadHistory(state.range).finally(() => scheduleHistory());
}

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

startPolling();
