CREATE INDEX IF NOT EXISTS idx_weather_source_type_time
  ON weather_records (site_id, source, record_type, observed_or_valid_at DESC);
