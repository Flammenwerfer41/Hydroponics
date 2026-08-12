import { jsonResponse as sharedJsonResponse, publicCorsHeaders } from "../http/response.js";
import {
  buildForecastPayload,
  buildWeatherPayload,
  JMA_ENDPOINTS,
  JMA_ENVIRONMENT_STATION_ID,
  mapUrlFor
} from "./contract.js";
import {
  latestObservationTime,
  latestStoredWeather,
  observationTimesToCollect,
  refreshStoredObservation,
  saveLatestForecast,
  saveObservations
} from "./store.js";

const CACHE_SECONDS = 5 * 60;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return sharedJsonResponse(body, status, {
    ...publicCorsHeaders(),
    ...extraHeaders
  });
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

async function latestJmaTime() {
  const latest = (await fetchText(`${JMA_ENDPOINTS.observations}/latest_time.txt`)).trim();
  const observedAt = new Date(latest);
  if (Number.isNaN(observedAt.getTime())) throw new Error("JMA latest_time was invalid");
  return observedAt;
}

async function fetchJmaMapAt(observedAt) {
  const map = await fetchJson(mapUrlFor(observedAt));
  if (!map?.[JMA_ENVIRONMENT_STATION_ID]) {
    throw new Error("Tokyo AMeDAS observation is missing");
  }
  return map;
}

async function fetchLatestJmaMap() {
  const observedAt = await latestJmaTime();

  for (let offset = 0; offset < 3; offset += 1) {
    const candidate = new Date(observedAt.getTime() - offset * 10 * 60_000);
    const candidateIso = candidate.toISOString();
    try {
      return { map: await fetchJmaMapAt(candidate), observedAt: candidateIso };
    } catch (error) {
      if (offset === 2) throw error;
    }
  }
  throw new Error("No usable JMA observation was found");
}

export function shouldCollectJmaObservation(now) {
  return now.getUTCMinutes() % 5 === 2;
}

export function shouldCollectJmaForecast(now) {
  return now.getUTCMinutes() === 7;
}

export async function archiveJmaWeather(environment, now, includeForecast = false) {
  const latest = await latestJmaTime();
  const previous = await latestObservationTime(environment.HYDROPONICS_DB);
  const times = observationTimesToCollect(previous, latest.toISOString());
  const observations = [];
  for (const observedAt of times) {
    try {
      const map = await fetchJmaMapAt(new Date(observedAt));
      observations.push(buildWeatherPayload(map, observedAt, now));
    } catch (error) {
      console.warn("JMA historical observation fetch skipped", { observedAt, error: error?.message });
    }
  }
  await saveObservations(environment.HYDROPONICS_DB, observations, now);

  let forecastSaved = false;
  if (includeForecast) {
    const forecast = await fetchJson(JMA_ENDPOINTS.forecast).then(buildForecastPayload);
    await saveLatestForecast(environment.HYDROPONICS_DB, forecast, now);
    forecastSaved = true;
  }
  return { observations: observations.length, forecast: forecastSaved };
}

export async function currentWeather(request, environment, context) {
  const requestUrl = new URL(request.url);
  const cacheKey = new Request(`${requestUrl.origin}/v1/current`, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("X-Weather-Cache", "HIT");
    return response;
  }

  if (environment.HYDROPONICS_DB) {
    try {
      const stored = await latestStoredWeather(environment.HYDROPONICS_DB);
      const payload = refreshStoredObservation(stored.observation);
      if (payload) {
        payload.forecast = stored.forecast;
        payload.quality.forecast_available = stored.forecast !== null;
        const response = jsonResponse(payload, 200, {
          "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
          "X-Weather-Cache": "D1"
        });
        context.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }
    } catch (error) {
      console.warn("Stored JMA weather lookup failed; falling back to JMA", error);
    }
  }

  const observationPromise = fetchLatestJmaMap();
  const forecastPromise = fetchJson(JMA_ENDPOINTS.forecast)
    .then(buildForecastPayload)
    .catch((error) => {
      console.warn("JMA forecast fetch failed", error);
      return null;
    });
  const [{ map, observedAt }, forecast] = await Promise.all([
    observationPromise,
    forecastPromise
  ]);
  const payload = buildWeatherPayload(map, observedAt);
  if (environment.HYDROPONICS_DB) {
    context.waitUntil(Promise.all([
      saveObservations(environment.HYDROPONICS_DB, [payload]),
      forecast ? saveLatestForecast(environment.HYDROPONICS_DB, forecast) : Promise.resolve()
    ]).catch((error) => console.error("Initial JMA cache persistence failed", error)));
  }
  payload.forecast = forecast;
  payload.quality.forecast_available = forecast !== null;
  const response = jsonResponse(payload, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    "X-Weather-Cache": "MISS"
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
