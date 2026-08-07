const JMA_BASE_URL = "https://www.jma.go.jp/bosai/amedas/data";
const ENVIRONMENT_STATION = Object.freeze({
  id: "44132",
  name: "東京",
  name_en: "Tokyo",
  distance_km: 13.1
});
const PRECIPITATION_STATION = Object.freeze({
  id: "44126",
  name: "世田谷",
  name_en: "Setagaya",
  distance_km: 2.8
});
const CACHE_SECONDS = 5 * 60;
const STALE_AFTER_MINUTES = 30;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const WIND_DIRECTIONS = Object.freeze([
  { ko: "고요", ja: "静穏", en: "Calm", degrees: null },
  { ko: "북북동", ja: "北北東", en: "NNE", degrees: 22.5 },
  { ko: "북동", ja: "北東", en: "NE", degrees: 45 },
  { ko: "동북동", ja: "東北東", en: "ENE", degrees: 67.5 },
  { ko: "동", ja: "東", en: "E", degrees: 90 },
  { ko: "동남동", ja: "東南東", en: "ESE", degrees: 112.5 },
  { ko: "남동", ja: "南東", en: "SE", degrees: 135 },
  { ko: "남남동", ja: "南南東", en: "SSE", degrees: 157.5 },
  { ko: "남", ja: "南", en: "S", degrees: 180 },
  { ko: "남남서", ja: "南南西", en: "SSW", degrees: 202.5 },
  { ko: "남서", ja: "南西", en: "SW", degrees: 225 },
  { ko: "서남서", ja: "西南西", en: "WSW", degrees: 247.5 },
  { ko: "서", ja: "西", en: "W", degrees: 270 },
  { ko: "서북서", ja: "西北西", en: "WNW", degrees: 292.5 },
  { ko: "북서", ja: "北西", en: "NW", degrees: 315 },
  { ko: "북북서", ja: "北北西", en: "NNW", degrees: 337.5 },
  { ko: "북", ja: "北", en: "N", degrees: 0 }
]);

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function readJmaField(record, field) {
  const raw = record?.[field];
  if (!Array.isArray(raw)) return { value: null, quality: null };
  const quality = finiteNumber(raw[1]);
  const observed = finiteNumber(raw[0]);
  return {
    value: quality === 0 ? observed : null,
    quality
  };
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function formatJstTimestamp(value) {
  return new Date(value.getTime() + JST_OFFSET_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+09:00");
}

export function calculateApparentTemperature(temperature, humidity, windSpeed) {
  if (![temperature, humidity, windSpeed].every(Number.isFinite)) return null;
  const vapourPressure =
    (humidity / 100) * 6.105 * Math.exp((17.27 * temperature) / (237.7 + temperature));
  return round(temperature + 0.33 * vapourPressure - 0.7 * windSpeed - 4, 1);
}

function windDirection(code) {
  if (!Number.isInteger(code) || !WIND_DIRECTIONS[code]) return null;
  return { code, ...WIND_DIRECTIONS[code] };
}

export function observationCondition(precipitation10m, sunshine10m) {
  if (Number.isFinite(precipitation10m) && precipitation10m > 0) {
    return { code: "precipitation", label_ko: "강수 관측", label_ja: "降水を観測" };
  }
  if (Number.isFinite(sunshine10m) && sunshine10m > 0) {
    return { code: "sunshine", label_ko: "일조 관측", label_ja: "日照あり" };
  }
  if (Number.isFinite(precipitation10m)) {
    return { code: "dry", label_ko: "강수 없음", label_ja: "降水なし" };
  }
  return { code: "unknown", label_ko: "관측 불가", label_ja: "観測不能" };
}

function pickPrecipitationRecord(environmentRecord, precipitationRecord) {
  const local10m = readJmaField(precipitationRecord, "precipitation10m");
  const local1h = readJmaField(precipitationRecord, "precipitation1h");
  if (local10m.value !== null || local1h.value !== null) {
    return {
      station: PRECIPITATION_STATION,
      precipitation10m: local10m,
      precipitation1h: local1h
    };
  }
  return {
    station: ENVIRONMENT_STATION,
    precipitation10m: readJmaField(environmentRecord, "precipitation10m"),
    precipitation1h: readJmaField(environmentRecord, "precipitation1h")
  };
}

export function buildWeatherPayload(map, observedAt, now = new Date()) {
  const environmentRecord = map?.[ENVIRONMENT_STATION.id];
  if (!environmentRecord) throw new Error("Tokyo AMeDAS observation is missing");

  const precipitationSelection = pickPrecipitationRecord(
    environmentRecord,
    map?.[PRECIPITATION_STATION.id]
  );
  const temperature = readJmaField(environmentRecord, "temp");
  const humidity = readJmaField(environmentRecord, "humidity");
  const stationPressure = readJmaField(environmentRecord, "pressure");
  const seaLevelPressure = readJmaField(environmentRecord, "normalPressure");
  const windSpeed = readJmaField(environmentRecord, "wind");
  const windDirectionValue = readJmaField(environmentRecord, "windDirection");
  const sunshine10m = readJmaField(environmentRecord, "sun10m");
  const sunshine1h = readJmaField(environmentRecord, "sun1h");
  const observedDate = new Date(observedAt);
  if (Number.isNaN(observedDate.getTime())) throw new Error("Invalid JMA observation time");
  const ageMinutes = Math.max(0, (now.getTime() - observedDate.getTime()) / 60_000);

  return {
    schema_version: 1,
    source: "JMA AMeDAS",
    observed_at: formatJstTimestamp(observedDate),
    generated_at: formatJstTimestamp(now),
    timezone: "Asia/Tokyo",
    stations: {
      environment: ENVIRONMENT_STATION,
      precipitation: precipitationSelection.station
    },
    current: {
      temperature: temperature.value,
      humidity: humidity.value,
      station_pressure: stationPressure.value,
      sea_level_pressure: seaLevelPressure.value,
      precipitation_10m: precipitationSelection.precipitation10m.value,
      precipitation_1h: precipitationSelection.precipitation1h.value,
      wind_speed: windSpeed.value,
      wind_direction: windDirection(windDirectionValue.value),
      sunshine_10m: sunshine10m.value,
      sunshine_1h: sunshine1h.value,
      apparent_temperature: calculateApparentTemperature(
        temperature.value,
        humidity.value,
        windSpeed.value
      )
    },
    condition: observationCondition(
      precipitationSelection.precipitation10m.value,
      sunshine10m.value
    ),
    quality: {
      stale: ageMinutes > STALE_AFTER_MINUTES,
      age_minutes: round(ageMinutes, 1),
      stale_after_minutes: STALE_AFTER_MINUTES,
      fields: {
        temperature: temperature.quality,
        humidity: humidity.quality,
        station_pressure: stationPressure.quality,
        sea_level_pressure: seaLevelPressure.quality,
        precipitation_10m: precipitationSelection.precipitation10m.quality,
        precipitation_1h: precipitationSelection.precipitation1h.quality,
        wind_speed: windSpeed.quality,
        wind_direction: windDirectionValue.quality,
        sunshine_10m: sunshine10m.quality,
        sunshine_1h: sunshine1h.quality
      }
    }
  };
}

export function mapUrlFor(observedAt) {
  const compact = formatJstTimestamp(observedAt)
    .replace(/[-:]/g, "")
    .replace("T", "")
    .slice(0, 12);
  return `${JMA_BASE_URL}/map/${compact}00.json`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    cf: { cacheEverything: true, cacheTtl: 60 }
  });
  if (!response.ok) throw new Error(`JMA returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    cf: { cacheEverything: true, cacheTtl: 60 }
  });
  if (!response.ok) throw new Error(`JMA returned HTTP ${response.status}`);
  return response.json();
}

async function fetchLatestJmaMap() {
  const latest = (await fetchText(`${JMA_BASE_URL}/latest_time.txt`)).trim();
  const observedAt = new Date(latest);
  if (Number.isNaN(observedAt.getTime())) throw new Error("JMA latest_time was invalid");

  for (let offset = 0; offset < 3; offset += 1) {
    const candidate = new Date(observedAt.getTime() - offset * 10 * 60_000);
    const candidateIso = candidate.toISOString();
    try {
      const map = await fetchJson(mapUrlFor(candidate));
      if (map?.[ENVIRONMENT_STATION.id]) return { map, observedAt: candidateIso };
    } catch (error) {
      if (offset === 2) throw error;
    }
  }
  throw new Error("No usable JMA observation was found");
}

async function currentWeather(request, context) {
  const requestUrl = new URL(request.url);
  const cacheKey = new Request(`${requestUrl.origin}/v1/current`, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("X-Weather-Cache", "HIT");
    return response;
  }

  const { map, observedAt } = await fetchLatestJmaMap();
  const payload = buildWeatherPayload(map, observedAt);
  const response = jsonResponse(payload, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    "X-Weather-Cache": "MISS"
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, _environment, context) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    } });
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, { "Allow": "GET, OPTIONS" });
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path !== "/" && path !== "/v1/current") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    try {
      return await currentWeather(request, context);
    } catch (error) {
      console.error("JMA weather fetch failed", error);
      return jsonResponse({
        error: "JMA observation is temporarily unavailable",
        generated_at: new Date().toISOString()
      }, 502, { "Cache-Control": "no-store" });
    }
  }
};
