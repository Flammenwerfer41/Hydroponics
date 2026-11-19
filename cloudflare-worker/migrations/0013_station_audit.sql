-- Administrator actions only; regular status polls do not create an event.
CREATE TABLE station_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES station_control(device_id),
  action TEXT NOT NULL CHECK(action IN ('register','approve','pause','maintenance','stop')),
  sha256 TEXT,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX idx_station_events_device_time ON station_events(device_id, created_at DESC);
