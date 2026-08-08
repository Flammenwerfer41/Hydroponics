PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  location_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE zones (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tower',
  position_label TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, name)
);

CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  position_index INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (zone_id, name),
  UNIQUE (zone_id, position_index)
);

CREATE TABLE crops (
  id TEXT PRIMARY KEY,
  common_name TEXT NOT NULL,
  scientific_name TEXT,
  cultivar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE crop_cycles (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plantings (
  id TEXT PRIMARY KEY,
  crop_cycle_id TEXT NOT NULL REFERENCES crop_cycles(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  crop_id TEXT NOT NULL REFERENCES crops(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  slot_id TEXT REFERENCES slots(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  planted_at TEXT NOT NULL,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE firmware_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  config_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (config_schema_version > 0),
  source_revision TEXT,
  released_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'esp32',
  hardware_model TEXT,
  firmware_release_id TEXT REFERENCES firmware_releases(id) ON DELETE SET NULL ON UPDATE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, name)
);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  label TEXT NOT NULL,
  secret_sha256 TEXT NOT NULL UNIQUE CHECK (length(secret_sha256) = 64),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE (device_id, label)
);

CREATE TABLE sensors (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  model TEXT,
  connection TEXT,
  installed_at TEXT NOT NULL,
  retired_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, name)
);

CREATE TABLE sensor_calibrations (
  id TEXT PRIMARY KEY,
  sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  calibrated_at TEXT NOT NULL,
  offset_value REAL,
  scale_value REAL,
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE actuators (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_provider TEXT,
  external_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, name)
);

CREATE TABLE readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  reading_id TEXT NOT NULL,
  boot_id TEXT,
  sequence INTEGER CHECK (sequence IS NULL OR sequence >= 0),
  measured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  firmware_version TEXT,
  reset_reason TEXT,
  source TEXT NOT NULL DEFAULT 'device',
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  remote_address_hash TEXT,
  UNIQUE (device_id, reading_id),
  UNIQUE (device_id, boot_id, sequence)
);

CREATE TABLE measurement_values (
  reading_pk INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  sensor_id TEXT REFERENCES sensors(id) ON DELETE SET NULL ON UPDATE RESTRICT,
  metric TEXT NOT NULL,
  value REAL,
  unit TEXT NOT NULL,
  quality TEXT NOT NULL
    CHECK (quality IN ('valid', 'missing', 'invalid', 'stale', 'suspect', 'calibrating')),
  diagnostic TEXT,
  PRIMARY KEY (reading_pk, metric),
  CHECK (
    (quality IN ('valid', 'stale', 'suspect', 'calibrating') AND value IS NOT NULL)
    OR (quality IN ('missing', 'invalid'))
  )
);

CREATE TABLE cultivation_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  crop_cycle_id TEXT REFERENCES crop_cycles(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  planting_id TEXT REFERENCES plantings(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  quantity_delta INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  crop_cycle_id TEXT REFERENCES crop_cycles(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  title TEXT,
  body TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  environment_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT REFERENCES journal_entries(id) ON DELETE SET NULL ON UPDATE RESTRICT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  captured_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE weather_records (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source TEXT NOT NULL,
  station_or_area_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('observation', 'forecast')),
  observed_or_valid_at TEXT NOT NULL,
  published_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source, station_or_area_id, record_type, observed_or_valid_at)
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  state TEXT NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_zones_site ON zones(site_id);
CREATE INDEX idx_slots_zone ON slots(zone_id);
CREATE INDEX idx_crop_cycles_site_started ON crop_cycles(site_id, started_at);
CREATE INDEX idx_plantings_cycle ON plantings(crop_cycle_id);
CREATE INDEX idx_devices_site_zone ON devices(site_id, zone_id);
CREATE INDEX idx_credentials_device_active ON device_credentials(device_id, revoked_at);
CREATE INDEX idx_sensors_device_metric ON sensors(device_id, metric);
CREATE INDEX idx_readings_device_measured ON readings(device_id, measured_at);
CREATE INDEX idx_readings_received ON readings(received_at);
CREATE INDEX idx_values_metric_reading ON measurement_values(metric, reading_pk);
CREATE INDEX idx_events_site_occurred ON cultivation_events(site_id, occurred_at);
CREATE INDEX idx_journal_site_observed ON journal_entries(site_id, observed_at);
CREATE INDEX idx_weather_site_time ON weather_records(site_id, observed_or_valid_at);
CREATE INDEX idx_alerts_site_state ON alerts(site_id, state, opened_at);

