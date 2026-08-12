export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function jstMidnight(timestamp = Date.now()) {
  const shifted = new Date(timestamp + JST_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - JST_OFFSET_MS;
}

export function historyDomain(range, now = Date.now()) {
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
  return { start: now - duration, end: now, previousStart: 0, todayStart: 0 };
}

export function calculateDerivedMetrics(temperature, humidity) {
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || humidity <= 0 || humidity > 100) {
    return null;
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
  return { discomfort, vpd, dewPoint, condensationGap: temperature - dewPoint };
}

export function parseRawHistory(readings) {
  return readings.map((reading) => ({
    time: Date.parse(reading.measured_at),
    temperature: finiteNumber(reading.values?.air_temperature),
    humidity: finiteNumber(reading.values?.humidity),
    pressure: finiteNumber(reading.values?.pressure),
    waterTemperature: finiteNumber(reading.values?.water_temperature)
  })).filter((point) => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
}

export function parseAggregateHistory(buckets) {
  return buckets.map((bucket) => ({
    time: Date.parse(bucket.start),
    temperature: finiteNumber(bucket.metrics?.air_temperature?.mean),
    humidity: finiteNumber(bucket.metrics?.humidity?.mean),
    pressure: finiteNumber(bucket.metrics?.pressure?.mean),
    waterTemperature: finiteNumber(bucket.metrics?.water_temperature?.mean)
  })).filter((point) => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
}

export function historyWindowQuery(config, window) {
  if (!window) return config.query;
  const parameters = new URLSearchParams({
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    device_id: "esp32-01"
  });
  if (config.paginated) parameters.set("limit", "1000");
  return parameters.toString();
}

export function lightHistoryQuery(range, window) {
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

export function mergeTimeSeries(current, incoming, earliest, end) {
  const pointsByTime = new Map();
  current.forEach((point) => pointsByTime.set(point.time, point));
  incoming.forEach((point) => pointsByTime.set(point.time, point));
  return [...pointsByTime.values()]
    .filter((point) => point.time >= earliest && point.time <= end)
    .sort((left, right) => left.time - right.time);
}

export function niceBounds(values, config) {
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
