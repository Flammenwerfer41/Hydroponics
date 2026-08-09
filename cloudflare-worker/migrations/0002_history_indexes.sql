-- Cursor pagination sorts by measurement time and uses the row ID as a stable
-- tie-breaker. Keep both the all-device and per-device paths indexable.
CREATE INDEX IF NOT EXISTS idx_readings_measured_id
  ON readings(measured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_readings_device_measured_id
  ON readings(device_id, measured_at DESC, id DESC);
