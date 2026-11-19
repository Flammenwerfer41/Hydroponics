-- Additive; old firmware ignores new control fields and remains compatible.
ALTER TABLE station_control ADD COLUMN normal_interval_seconds INTEGER CHECK(normal_interval_seconds IN (300,600,900,1800,3600));
ALTER TABLE station_control ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE station_control ADD COLUMN manual_ota_expires_at TEXT;
ALTER TABLE station_control ADD COLUMN manual_ota_sha256 TEXT;
ALTER TABLE readings ADD COLUMN station_schedule TEXT;
CREATE TABLE station_policy_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES station_control(device_id),
  action TEXT NOT NULL CHECK(action IN ('schedule','manual_ota')),
  details TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX idx_station_policy_events_device_time ON station_policy_events(device_id,created_at DESC);
