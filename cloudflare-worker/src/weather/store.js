const SITE_ID = "home-lab";
const SOURCE = "JMA";
const OBSERVATION_STATIONS = "44132+44126";
const FORECAST_AREA = "130010";
const TEN_MINUTES_MS = 10 * 60_000;

function parsePayload(row) {
  if (!row?.payload_json) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch (error) {
    console.error("Stored JMA payload is invalid JSON", error);
    return null;
  }
}

function recordId(type, key) {
  return `jma-${type}-${key.replace(/[^0-9a-z]/gi, "")}`;
}

export function observationTimesToCollect(lastStoredAt, latestAt, limit = 12) {
  const latest = new Date(latestAt);
  if (Number.isNaN(latest.getTime())) return [];
  const last = lastStoredAt ? new Date(lastStoredAt) : null;
  if (last && !Number.isNaN(last.getTime()) && last.getTime() >= latest.getTime()) return [];
  if (!last || Number.isNaN(last.getTime())) return [latest.toISOString()];

  const earliestRecent = latest.getTime() - (limit - 1) * TEN_MINUTES_MS;
  const firstMissing = last.getTime() + TEN_MINUTES_MS;
  const start = Math.max(firstMissing, earliestRecent);
  const times = [];
  for (let time = start; time <= latest.getTime(); time += TEN_MINUTES_MS) {
    times.push(new Date(time).toISOString());
  }
  return times;
}

export async function latestObservationTime(database) {
  const row = await database.prepare(`
    SELECT observed_or_valid_at
    FROM weather_records
    WHERE site_id = ?1 AND source = ?2 AND station_or_area_id = ?3
      AND record_type = 'observation'
    ORDER BY observed_or_valid_at DESC
    LIMIT 1
  `).bind(SITE_ID, SOURCE, OBSERVATION_STATIONS).first();
  return row?.observed_or_valid_at ?? null;
}

export async function saveObservations(database, payloads, fetchedAt = new Date()) {
  if (!payloads.length) return;
  const createdAt = fetchedAt.toISOString();
  await database.batch(payloads.map((payload) => database.prepare(`
    INSERT OR IGNORE INTO weather_records
      (id, site_id, source, station_or_area_id, record_type,
       observed_or_valid_at, published_at, payload_json, created_at)
    VALUES (?1, ?2, ?3, ?4, 'observation', ?5, NULL, ?6, ?7)
  `).bind(
    recordId("observation", payload.observed_at),
    SITE_ID,
    SOURCE,
    OBSERVATION_STATIONS,
    payload.observed_at,
    JSON.stringify(payload),
    createdAt
  )));
}

export async function saveLatestForecast(database, forecast, fetchedAt = new Date()) {
  if (!forecast?.published_at) return;
  const timestamp = fetchedAt.toISOString();
  await database.batch([
    database.prepare(`
      INSERT OR IGNORE INTO weather_records
        (id, site_id, source, station_or_area_id, record_type,
         observed_or_valid_at, published_at, payload_json, created_at)
      VALUES (?1, ?2, ?3, ?4, 'forecast', ?5, ?5, ?6, ?7)
    `).bind(
      recordId("forecast", forecast.published_at),
      SITE_ID,
      SOURCE,
      FORECAST_AREA,
      forecast.published_at,
      JSON.stringify(forecast),
      timestamp
    ),
    database.prepare(`
      DELETE FROM weather_records
      WHERE site_id = ?1 AND source = ?2 AND station_or_area_id = ?3
        AND record_type = 'forecast' AND observed_or_valid_at <> ?4
    `).bind(SITE_ID, SOURCE, FORECAST_AREA, forecast.published_at)
  ]);
}

export async function latestStoredWeather(database) {
  const [observation, forecast] = await Promise.all([
    database.prepare(`
      SELECT payload_json FROM weather_records
      WHERE site_id = ?1 AND source = ?2 AND station_or_area_id = ?3
        AND record_type = 'observation'
      ORDER BY observed_or_valid_at DESC LIMIT 1
    `).bind(SITE_ID, SOURCE, OBSERVATION_STATIONS).first(),
    database.prepare(`
      SELECT payload_json FROM weather_records
      WHERE site_id = ?1 AND source = ?2 AND station_or_area_id = ?3
        AND record_type = 'forecast'
      ORDER BY observed_or_valid_at DESC LIMIT 1
    `).bind(SITE_ID, SOURCE, FORECAST_AREA).first()
  ]);
  return { observation: parsePayload(observation), forecast: parsePayload(forecast) };
}

export function refreshStoredObservation(payload, now = new Date()) {
  if (!payload?.observed_at) return null;
  const observedAt = new Date(payload.observed_at);
  if (Number.isNaN(observedAt.getTime())) return null;
  const ageMinutes = Math.max(0, (now.getTime() - observedAt.getTime()) / 60_000);
  return {
    ...payload,
    generated_at: new Date(now.getTime() + 9 * 60 * 60 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, "+09:00"),
    quality: {
      ...payload.quality,
      stale: ageMinutes > (payload.quality?.stale_after_minutes ?? 30),
      age_minutes: Math.round(ageMinutes * 10) / 10,
      storage: "D1"
    }
  };
}
