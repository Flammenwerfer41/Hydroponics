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

