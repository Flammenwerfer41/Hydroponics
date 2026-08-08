-- Optional development fixtures. Do not apply this file as a migration.
-- It demonstrates that the current tower and a future second tower share one schema.

INSERT INTO sites (id, name, timezone, created_at, updated_at) VALUES
  ('home-lab', 'Home hydroponics', 'Asia/Tokyo', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT INTO zones (id, site_id, name, kind, created_at, updated_at) VALUES
  ('tower-01', 'home-lab', 'Vertical tower 1', 'tower', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-02', 'home-lab', 'Future vertical tower 2', 'tower', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT INTO firmware_releases
  (id, version, config_schema_version, created_at)
VALUES
  ('firmware-8-1-0', '8.1.0', 1, '2026-08-09T00:00:00Z');

INSERT INTO devices
  (id, site_id, zone_id, name, kind, hardware_model, firmware_release_id, created_at, updated_at)
VALUES
  ('esp32-01', 'home-lab', 'tower-01', 'Tower 1 monitor', 'esp32', 'ESP32-WROOM-32D', 'firmware-8-1-0', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('esp32-02', 'home-lab', 'tower-02', 'Future tower 2 monitor', 'esp32', 'ESP32-WROOM-32D', 'firmware-8-1-0', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT INTO sensors
  (id, device_id, zone_id, name, metric, model, connection, installed_at, created_at, updated_at)
VALUES
  ('tower-01-bme280-temperature', 'esp32-01', 'tower-01', 'Tower 1 air temperature', 'air_temperature', 'BME280', 'I2C SDA18 SCL19', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-ds18b20-water', 'esp32-01', 'tower-01', 'Tower 1 water temperature', 'water_temperature', 'DS18B20', 'OneWire GPIO21', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

