PRAGMA foreign_keys = ON;

UPDATE actuators
SET device_id = NULL,
    external_id = 'configured-in-worker-secrets',
    updated_at = '2026-08-09T00:00:00Z'
WHERE id = 'tower-01-grow-light';

INSERT OR IGNORE INTO actuators
  (id, site_id, zone_id, device_id, name, kind, external_provider, external_id,
   created_at, updated_at)
VALUES
  ('room-air-conditioner', 'home-lab', 'tower-01', NULL, 'Room air conditioner',
   'air_conditioner', 'SwitchBot', 'configured-in-worker-secrets',
   '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO automation_settings
  (actuator_id, enabled, timezone, on_minute, off_minute, updated_at, updated_by)
VALUES
  ('tower-01-grow-light', 1, 'Asia/Tokyo', 420, 1260,
   '2026-08-09T00:00:00Z', 'initial activation');
