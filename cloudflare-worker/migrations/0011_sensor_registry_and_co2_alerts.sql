PRAGMA foreign_keys = ON;

UPDATE sensors
SET connection = 'I2C0 SDA23 SCL22', updated_at = '2026-09-01T00:00:00Z'
WHERE id IN (
  'tower-01-bme280-temperature',
  'tower-01-bme280-humidity',
  'tower-01-bme280-pressure'
);

UPDATE sensors
SET connection = 'OneWire GPIO15', updated_at = '2026-09-01T00:00:00Z'
WHERE id = 'tower-01-ds18b20-water';

INSERT OR IGNORE INTO sensors
  (id, device_id, zone_id, name, metric, model, connection, installed_at,
   created_at, updated_at)
VALUES
  ('tower-01-scd40-co2', 'esp32-01', 'tower-01', 'Indoor CO2 concentration',
   'co2_concentration', 'SCD40', 'I2C1 SDA26 SCL27; VIN 5V',
   '2026-08-31T00:00:00Z', '2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('tower-01-veml7700-illuminance', 'esp32-01', 'tower-01', 'Grow-light illuminance',
   'illuminance', 'VEML7700', 'I2C0 SDA23 SCL22; 3.3V',
   '2026-08-31T00:00:00Z', '2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z');

INSERT INTO alert_rules (
  id, site_id, alert_type, metric, direction, title_ko, title_ja, unit,
  warning_enter, warning_exit, warning_duration_seconds,
  critical_enter, critical_exit, critical_duration_seconds,
  recovery_duration_seconds, sort_order, config_json, created_at, updated_at
) VALUES
  ('rule-missing-co2', 'home-lab', 'sensor_missing_co2_concentration',
   'co2_concentration', 'missing',
   'CO₂ 센서 측정 실패', 'CO₂センサー計測失敗', 'ppm',
   3, 0, 0, 10, 0, 0, 0, 24,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('rule-missing-illuminance', 'home-lab', 'sensor_missing_illuminance',
   'illuminance', 'missing',
   '조도 센서 측정 실패', '照度センサー計測失敗', 'lux',
   3, 0, 0, 10, 0, 0, 0, 25,
   '{"device_id":"esp32-01","recovery_readings":2}',
   '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('rule-high-co2', 'home-lab', 'high_co2_concentration',
   'co2_concentration', 'high',
   '실내 CO₂ 환기 필요', '室内CO₂換気が必要', 'ppm',
   1500, 1200, 1800, 2500, 2000, 900, 900, 45, '{}',
   '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
