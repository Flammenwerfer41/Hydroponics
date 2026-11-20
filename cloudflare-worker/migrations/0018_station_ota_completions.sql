-- Installation confirmations are distinct from administrator pause/approval events.
CREATE TABLE station_ota_completions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES station_control(device_id),
  sha256 TEXT NOT NULL REFERENCES station_releases(sha256),
  measured_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE INDEX idx_station_ota_completions_device_time ON station_ota_completions(device_id, completed_at DESC);
