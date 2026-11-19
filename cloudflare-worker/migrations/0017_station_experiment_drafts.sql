CREATE TABLE station_experiment_drafts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  recipe TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  approved_id TEXT UNIQUE REFERENCES station_experiments(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX station_drafts_device ON station_experiment_drafts(device_id,updated_at DESC);
