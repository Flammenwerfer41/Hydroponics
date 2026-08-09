PRAGMA foreign_keys = ON;

CREATE TABLE actuator_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actuator_id TEXT NOT NULL REFERENCES actuators(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  power_state TEXT CHECK (power_state IN ('on', 'off', 'unknown')),
  power_w REAL,
  voltage_v REAL,
  current_a REAL,
  runtime_minutes INTEGER CHECK (runtime_minutes IS NULL OR runtime_minutes BETWEEN 0 AND 1440),
  quality TEXT NOT NULL CHECK (quality IN ('valid', 'invalid', 'unavailable')),
  provider_status INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (actuator_id, observed_at)
);

CREATE TABLE actuator_commands (
  id TEXT PRIMARY KEY,
  actuator_id TEXT NOT NULL REFERENCES actuators(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  requested_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'schedule', 'system')),
  actor_id TEXT,
  command TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  provider_status INTEGER,
  provider_message TEXT,
  completed_at TEXT
);

CREATE TABLE automation_settings (
  actuator_id TEXT PRIMARY KEY REFERENCES actuators(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  on_minute INTEGER NOT NULL CHECK (on_minute BETWEEN 0 AND 1439),
  off_minute INTEGER NOT NULL CHECK (off_minute BETWEEN 0 AND 1439),
  override_state TEXT CHECK (override_state IN ('on', 'off')),
  override_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE INDEX idx_actuator_telemetry_time
  ON actuator_telemetry(actuator_id, observed_at DESC, id DESC);
CREATE INDEX idx_actuator_commands_time
  ON actuator_commands(actuator_id, requested_at DESC);
