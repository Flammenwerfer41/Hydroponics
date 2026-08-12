PRAGMA foreign_keys = ON;

CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  alert_type TEXT NOT NULL,
  metric TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('high', 'low', 'gap', 'missing', 'mismatch')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  title_ko TEXT NOT NULL,
  title_ja TEXT NOT NULL,
  unit TEXT,
  warning_enter REAL,
  warning_exit REAL,
  warning_duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (warning_duration_seconds >= 0),
  critical_enter REAL,
  critical_exit REAL,
  critical_duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (critical_duration_seconds >= 0),
  recovery_duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (recovery_duration_seconds >= 0),
  public INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, alert_type)
);

CREATE TABLE alert_rule_states (
  rule_id TEXT PRIMARY KEY REFERENCES alert_rules(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  state TEXT NOT NULL DEFAULT 'normal' CHECK (state IN ('normal', 'warning', 'critical')),
  pending_state TEXT CHECK (pending_state IN ('normal', 'warning', 'critical')),
  pending_since TEXT,
  active_alert_id TEXT REFERENCES alerts(id) ON DELETE SET NULL ON UPDATE RESTRICT,
  last_value REAL,
  last_observed_at TEXT,
  last_evaluated_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL
);

CREATE TABLE alert_notifications (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'escalated', 'resolved')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical', 'info')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_alert_rules_enabled ON alert_rules(site_id, enabled, sort_order);
CREATE INDEX idx_alert_notifications_pending
  ON alert_notifications(status, next_attempt_at, created_at);

INSERT INTO alert_rules (
  id, site_id, alert_type, metric, direction, title_ko, title_ja, unit,
  warning_enter, warning_exit, warning_duration_seconds,
  critical_enter, critical_exit, critical_duration_seconds,
  recovery_duration_seconds, sort_order, config_json, created_at, updated_at
) VALUES
  ('rule-device-gap', 'home-lab', 'device_data_gap', NULL, 'gap',
   '측정 데이터 수신 중단', '計測データ受信停止', NULL,
   600, 300, 0, 1800, 300, 0, 0, 10,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-missing-temperature', 'home-lab', 'sensor_missing_air_temperature', 'air_temperature', 'missing',
   '기온 센서 측정 실패', '気温センサー計測失敗', '°C',
   3, 0, 0, 10, 0, 0, 0, 20,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-missing-humidity', 'home-lab', 'sensor_missing_humidity', 'humidity', 'missing',
   '습도 센서 측정 실패', '湿度センサー計測失敗', '%',
   3, 0, 0, 10, 0, 0, 0, 21,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-missing-pressure', 'home-lab', 'sensor_missing_pressure', 'pressure', 'missing',
   '기압 센서 측정 실패', '気圧センサー計測失敗', 'hPa',
   3, 0, 0, 10, 0, 0, 0, 22,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-missing-water', 'home-lab', 'sensor_missing_water_temperature', 'water_temperature', 'missing',
   '수온 센서 측정 실패', '水温センサー計測失敗', '°C',
   3, 0, 0, 10, 0, 0, 0, 23,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-light-control', 'home-lab', 'light_control_mismatch', NULL, 'mismatch',
   '조명 상태 확인 필요', '照明状態の確認が必要', NULL,
   1, 0, 600, 1, 0, 1200, 300, 30,
   '{"actuator_id":"tower-01-grow-light","power_threshold_w":5}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-high-air-temperature', 'home-lab', 'high_air_temperature', 'air_temperature', 'high',
   '실내 고온', '室内高温', '°C',
   32, 31, 1800, 35, 34, 600, 900, 40, '{}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-low-air-temperature', 'home-lab', 'low_air_temperature', 'air_temperature', 'low',
   '실내 저온', '室内低温', '°C',
   15, 16, 1800, 10, 12, 900, 900, 41, '{}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-high-vpd', 'home-lab', 'high_vpd', 'vpd', 'high',
   '고VPD', '高VPD', 'kPa',
   2.5, 2.3, 1800, 3.0, 2.7, 900, 900, 42, '{}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-high-water-temperature', 'home-lab', 'high_water_temperature', 'water_temperature', 'high',
   '고수온', '高水温', '°C',
   28, 27.5, 1800, 30, 29, 900, 900, 43, '{}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
  ('rule-low-water-temperature', 'home-lab', 'low_water_temperature', 'water_temperature', 'low',
   '저수온', '低水温', '°C',
   18, 19, 1800, 15, 16, 900, 900, 44, '{}',
   '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z');
