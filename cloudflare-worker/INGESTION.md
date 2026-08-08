# Measurement ingestion contract

This contract is intentionally independent of ThingSpeak field numbers. The device
identity comes from its bearer credential, not from a caller-controlled `device_id`.

## Identity rules

- `device_id`: immutable server-side ID associated with one credential.
- `boot_id`: 8-64 characters generated once per ESP32 boot.
- `sequence`: non-negative counter that increases during a boot.
- `reading_id`: 8-128 characters and stable across every replay. The recommended
  ESP32 form is `<boot_id>:<sequence>`.
- `(device_id, reading_id)` is unique. `(device_id, boot_id, sequence)` is an
  additional consistency guard.
- `measured_at` is the sensor time; D1 adds `received_at` at ingestion.

## Version 1 payload

```json
{
  "schema_version": 1,
  "reading_id": "boot0001:42",
  "boot_id": "boot0001",
  "sequence": 42,
  "measured_at": "2026-08-09T09:59:00+09:00",
  "firmware_version": "8.1.0",
  "reset_reason": "power_on",
  "values": {
    "air_temperature": 25.3,
    "humidity": null,
    "pressure": 1007.8,
    "wifi_rssi": -57,
    "water_temperature": 24.6,
    "light_status": 1,
    "light_power": 73.7,
    "light_uptime": 180
  },
  "quality": {
    "humidity": "missing"
  },
  "diagnostics": {
    "humidity": "bme280_read_failed"
  }
}
```

Quality is stored independently for every supplied field: `valid`, `missing`,
`invalid`, `stale`, `suspect`, or `calibrating`. A finite value defaults to `valid`;
`null` defaults to `missing`. Values outside the physical input bounds are retained
for diagnostics but marked `invalid`, so they can be excluded from normal summaries.

The initial metric names and units are:

| Metric | Unit |
| --- | --- |
| `air_temperature` | `degC` |
| `humidity` | `percent` |
| `pressure` | `hPa` |
| `wifi_rssi` | `dBm` |
| `water_temperature` | `degC` |
| `light_status` | `state` (0 or 1) |
| `light_power` | `W` |
| `light_uptime` | `min` |

Metric names are versioned to prevent silent typos. Adding EC, pH or another future
measurement requires a contract update but does not require a D1 schema redesign.

## Endpoints

- `POST /v1/readings`: one version 1 reading
- `POST /v1/readings/bulk`: `{ "schema_version": 1, "readings": [...] }`
- Maximum batch size: 15 readings
- Maximum JSON body: 128 KiB
- Authentication: `Authorization: Bearer <device credential>`

Both endpoints use the same validation and persistence path. A single response has
HTTP 201 for `accepted`, HTTP 200 for `duplicate`, HTTP 409 for an identity conflict,
and HTTP 422 for invalid input. A valid bulk envelope returns HTTP 200 and reports
each item independently as `accepted`, `duplicate`, or `rejected`. Firmware must only
mark a LittleFS record complete after `accepted` or `duplicate`.

The 15-reading limit keeps a worst-case request below the D1 Free limit of 50 queries
per Worker invocation. A device with more pending records sends multiple batches.

The credential itself is never stored. Store its lowercase SHA-256 digest in
`device_credentials.secret_sha256`; the Worker hashes the bearer value before D1
lookup. Revoking one row disables only that device credential. Configure the D1
binding as `HYDROPONICS_DB`. The optional secret `AUDIT_HASH_SALT` enables a salted
hash of the source address for diagnostics; raw addresses are not persisted.

Run `npm run credential:create` locally to generate a bearer value and its digest.
Copy the bearer value into the device's untracked `secrets.h`, then insert only the
digest into D1 after creating the matching site, zone and device records:

```sql
INSERT INTO device_credentials
  (id, device_id, label, secret_sha256, created_at)
VALUES
  ('esp32-01-primary', 'esp32-01', 'primary', '<SHA-256 digest>', '<UTC timestamp>');
```

The generated bearer value is displayed once and must not be committed, pasted into
an issue, or stored in D1 as plaintext.

Until the D1 binding and at least one device credential exist, the existing weather
routes continue to work and ingestion returns HTTP 503 without changing any data.
