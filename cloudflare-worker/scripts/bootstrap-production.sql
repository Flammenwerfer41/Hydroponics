-- Production bootstrap template. The provisioning script replaces the credential
-- digest placeholder in an ignored .wrangler file before this is sent to D1.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO sites
  (id, name, timezone, location_label, created_at, updated_at)
VALUES
  ('home-lab', 'Home hydroponics', 'Asia/Tokyo', 'Todoroki, Tokyo',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO zones
  (id, site_id, name, kind, position_label, created_at, updated_at)
VALUES
  ('tower-01', 'home-lab', 'Vertical tower 1', 'tower', 'Indoor studio',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO firmware_releases
  (id, version, config_schema_version, source_revision, released_at, notes, created_at)
VALUES
  ('firmware-8-2-0', '8.2.0', 1, '7ecc5ff', '2026-08-09T00:00:00Z',
   'ThingSpeak and Cloudflare acknowledged dual-write', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO devices
  (id, site_id, zone_id, name, kind, hardware_model, firmware_release_id,
   created_at, updated_at)
VALUES
  ('esp32-01', 'home-lab', 'tower-01', 'Tower 1 monitor', 'esp32',
   'ESP32-WROOM-32D', 'firmware-8-2-0',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO sensors
  (id, device_id, zone_id, name, metric, model, connection, installed_at,
   created_at, updated_at)
VALUES
  ('tower-01-bme280-temperature', 'esp32-01', 'tower-01', 'Air temperature',
   'air_temperature', 'BME280', 'I2C SDA18 SCL19', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-bme280-humidity', 'esp32-01', 'tower-01', 'Air humidity',
   'humidity', 'BME280', 'I2C SDA18 SCL19', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-bme280-pressure', 'esp32-01', 'tower-01', 'Air pressure',
   'pressure', 'BME280', 'I2C SDA18 SCL19', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-ds18b20-water', 'esp32-01', 'tower-01', 'Nutrient water temperature',
   'water_temperature', 'DS18B20', 'OneWire GPIO21', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-wifi-rssi', 'esp32-01', 'tower-01', 'Wi-Fi signal strength',
   'wifi_rssi', 'ESP32-WROOM-32D', 'Integrated Wi-Fi', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-switchbot-status', 'esp32-01', 'tower-01', 'Grow light status',
   'light_status', 'SwitchBot Plug Mini', 'SwitchBot OpenAPI', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-switchbot-power', 'esp32-01', 'tower-01', 'Grow light power',
   'light_power', 'SwitchBot Plug Mini', 'SwitchBot OpenAPI', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tower-01-switchbot-uptime', 'esp32-01', 'tower-01', 'Grow light uptime',
   'light_uptime', 'SwitchBot Plug Mini', 'SwitchBot OpenAPI', '2026-08-09T00:00:00Z',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO actuators
  (id, site_id, zone_id, device_id, name, kind, external_provider, external_id,
   created_at, updated_at)
VALUES
  ('tower-01-grow-light', 'home-lab', 'tower-01', NULL, 'Grow light',
   'power_switch', 'SwitchBot', 'configured-in-worker-secrets',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('room-air-conditioner', 'home-lab', 'tower-01', NULL, 'Room air conditioner',
   'air_conditioner', 'SwitchBot', 'configured-in-worker-secrets',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT INTO device_credentials
  (id, device_id, label, secret_sha256, created_at)
VALUES
  ('esp32-01-primary', 'esp32-01', 'firmware primary',
   '__DEVICE_SECRET_SHA256__', '2026-08-09T00:00:00Z')
ON CONFLICT(id) DO UPDATE SET
  secret_sha256 = excluded.secret_sha256,
  revoked_at = NULL;
