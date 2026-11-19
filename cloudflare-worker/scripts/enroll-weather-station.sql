-- MANUAL provisioning, after migration 0012. Review before remote execution.
-- Does not create a token, activate an OTA release or touch the tower.
INSERT OR IGNORE INTO zones (id, site_id, name, kind, position_label, created_at, updated_at)
VALUES ('balcony-01', 'home-lab', 'Balcony weather station', 'weather_station',
  'Apartment balcony', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO devices (id, site_id, zone_id, name, kind, hardware_model, active, created_at, updated_at)
VALUES ('balcony-weather-01', 'home-lab', 'balcony-01', 'Balcony weather monitor', 'esp32',
  'firebeetle2-esp32c6-v1.2', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO station_control (device_id, hardware, updated_at, updated_by)
VALUES ('balcony-weather-01', 'firebeetle2-esp32c6-v1.2', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'manual-enrollment');
INSERT OR IGNORE INTO sensors
  (id, device_id, zone_id, name, metric, model, connection, installed_at, created_at, updated_at)
SELECT 'balcony-01-' || metric, 'balcony-weather-01', 'balcony-01', metric, metric, model, connection,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM (
  SELECT 'air_temperature' AS metric, 'BME280' AS model, 'SDA19/SCL20' AS connection
  UNION ALL SELECT 'humidity', 'BME280', 'SDA19/SCL20'
  UNION ALL SELECT 'pressure', 'BME280', 'SDA19/SCL20'
  UNION ALL SELECT 'battery_voltage', 'DFR1075 divider', 'ADC0, ratio 2'
);
