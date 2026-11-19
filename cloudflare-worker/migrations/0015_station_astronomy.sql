ALTER TABLE readings ADD COLUMN astronomy TEXT;
-- One closing per device/JST date. Late replay can replace it only with an earlier observation.
CREATE TABLE station_night_closings (
  device_id TEXT NOT NULL REFERENCES devices(id),
  closing_date TEXT NOT NULL,
  reading_pk INTEGER NOT NULL REFERENCES readings(id),
  measured_at TEXT NOT NULL,
  PRIMARY KEY(device_id,closing_date)
);
