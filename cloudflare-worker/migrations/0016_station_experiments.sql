-- Manual, bounded experiments only. Never mix samples into weather readings.
ALTER TABLE station_control ADD COLUMN discard_experiment_sequence INTEGER;
CREATE TABLE station_experiments (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence <= 2147483647),
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  recipe TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','receiving','completed','cancelled','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  result_meta TEXT
);
CREATE INDEX station_experiments_device ON station_experiments(device_id, sequence DESC);
CREATE UNIQUE INDEX station_experiments_active ON station_experiments(device_id)
  WHERE status='queued';
CREATE TABLE station_experiment_chunks (
  experiment_id TEXT NOT NULL REFERENCES station_experiments(id),
  offset INTEGER NOT NULL CHECK(offset >= 0 AND offset < 600 AND offset % 100 = 0),
  sample_count INTEGER NOT NULL CHECK(sample_count BETWEEN 0 AND 100),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(experiment_id, offset)
);
CREATE TABLE station_experiment_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  action TEXT NOT NULL CHECK(action IN ('experiment','experiment_cancel')),
  details TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX station_experiment_events_device ON station_experiment_events(device_id,created_at DESC);
