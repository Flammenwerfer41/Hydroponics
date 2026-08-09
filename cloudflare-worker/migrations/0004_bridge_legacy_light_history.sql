PRAGMA foreign_keys = ON;

-- ThingSpeak Fields 6-8 were already imported into measurement_values before
-- actuator_telemetry became the canonical grow-light history. Bridge those
-- rows in place so the dashboard keeps its historical light intervals.
INSERT OR IGNORE INTO actuator_telemetry (
  actuator_id,
  observed_at,
  received_at,
  power_state,
  power_w,
  voltage_v,
  current_a,
  runtime_minutes,
  quality,
  provider_status,
  payload_json
)
SELECT
  'tower-01-grow-light',
  legacy.measured_at,
  legacy.received_at,
  CASE
    WHEN legacy.light_status >= 0.5 THEN 'on'
    WHEN legacy.light_status IS NOT NULL THEN 'off'
    WHEN legacy.light_power > 0.5 THEN 'on'
    WHEN legacy.light_power IS NOT NULL THEN 'off'
    ELSE 'unknown'
  END,
  legacy.light_power,
  NULL,
  NULL,
  CASE
    WHEN legacy.light_uptime BETWEEN 0 AND 1440 THEN CAST(legacy.light_uptime AS INTEGER)
    ELSE NULL
  END,
  CASE
    WHEN legacy.light_status IS NOT NULL OR legacy.light_power IS NOT NULL THEN 'valid'
    ELSE 'unavailable'
  END,
  NULL,
  json_object(
    'source', legacy.source,
    'reading_id', legacy.reading_id,
    'migration', '0004_bridge_legacy_light_history'
  )
FROM (
  SELECT
    r.id,
    r.reading_id,
    r.source,
    r.measured_at,
    r.received_at,
    MAX(CASE
      WHEN mv.metric = 'light_status' AND mv.quality IN ('valid', 'stale', 'suspect')
      THEN mv.value
    END) AS light_status,
    MAX(CASE
      WHEN mv.metric = 'light_power' AND mv.quality IN ('valid', 'stale', 'suspect')
      THEN mv.value
    END) AS light_power,
    MAX(CASE
      WHEN mv.metric = 'light_uptime' AND mv.quality IN ('valid', 'stale', 'suspect')
      THEN mv.value
    END) AS light_uptime
  FROM readings r
  JOIN measurement_values mv ON mv.reading_pk = r.id
  WHERE mv.metric IN ('light_status', 'light_power', 'light_uptime')
  GROUP BY r.id, r.reading_id, r.source, r.measured_at, r.received_at
) AS legacy
WHERE legacy.light_status IS NOT NULL
   OR legacy.light_power IS NOT NULL
   OR legacy.light_uptime IS NOT NULL;
