-- Additive only. No station is activated and no tower row is modified.
CREATE TABLE station_releases (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  hardware TEXT NOT NULL,
  version TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 512 AND 1769472),
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(hardware, version)
);
CREATE TABLE station_control (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  hardware TEXT NOT NULL,
  target_sha256 TEXT REFERENCES station_releases(sha256),
  maintenance_id TEXT,
  maintenance_expires_at TEXT,
  reported_at TEXT,
  reported_status TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
