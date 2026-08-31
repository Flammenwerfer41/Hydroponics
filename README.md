# ESP32 Hydroponics Environment Monitor

[![한국어 README](https://img.shields.io/badge/README-한국어-0d815c)](README.ko.md)

An ESP32-WROOM-32D-based hydroponics monitoring, recording, and control system.
The sensor node preserves measurements locally during network outages, while a
Cloudflare Worker and D1 provide the public dashboard, cultivation journal,
alerts, and SwitchBot grow-light control.

- **Production firmware:** v8.5.0
- **Framework:** PlatformIO · Arduino
- **Production dashboard:** [Cloudflare Worker](https://hydroponics-jma-weather.flammenwerfer41.workers.dev/)
- **Emergency mirror:** [GitHub Pages](https://flammenwerfer41.github.io/Hydroponics/)
- **System architecture:** [English](docs/architecture/TOWER_SYSTEM.en.md) · [한국어](docs/architecture/TOWER_SYSTEM.md)

## Highlights

- BME280 air temperature, humidity, and pressure; DS18B20 nutrient temperature;
  SCD40 CO₂; and VEML7700 illuminance
- Raw lux retention with a versioned coefficient for estimated PPFD in the dashboard
- Approximately two-minute sampling and a 14-day LittleFS ring buffer
- Oldest-first, idempotent single and bulk backfill after network recovery
- Cloudflare Worker device authentication, D1 history, and R2 photo/backup storage
- Public and administrative dashboards, Cloudflare Access, and a cultivation journal
  with client-compressed WebP photos
- Long-term official JMA observation storage and a Tokyo regional forecast
- Stateful Discord advisory, warning, and recovery notifications
- SwitchBot Plug Mini state, power, schedule, and remote grow-light commands
- Arduino OTA

ThingSpeak ingestion and reads were retired on 2026-08-09. Historical records
were migrated to D1; the ESP32, dashboards, and reports now use the Cloudflare path.

## Hardware

| Component | Power and connection | Responsibility |
| --- | --- | --- |
| ESP32 | 30-pin NodeMCU-32S-compatible board, USB-C 5 V | Sampling, local retention, upload, OTA |
| BME280 | 3.3 V, SDA 23 / SCL 22 | Air temperature, RH, pressure |
| VEML7700 | 3.3 V, SDA 23 / SCL 22 | Illuminance |
| SCD40 | VIN 5 V, SDA 26 / SCL 27 | CO₂ with BME280 pressure compensation |
| DS18B20 | 3.3 V, DATA 15, 4.7 kΩ pull-up | Nutrient temperature |

The BME280 and VEML7700 share the primary I²C bus; the SCD40 uses the secondary
I²C bus. On the production unit, the SCD40 is powered from VIN 5 V and connected
directly to GPIO26/27 without a separate level shifter. This is an owner-approved
operating exception, not a general reference circuit based on the official datasheet.

See the [tower system architecture](docs/architecture/TOWER_SYSTEM.en.md) for the
AC/DC power distribution, circulation pump, grow lights, sensor buses, and complete
data flow.

## Software boundaries

```text
Sensors → ESP32 → LittleFS → Cloudflare Worker → D1 → Dashboard and alerts
                                                  └→ R2 photos and backups
Admin → Cloudflare Access → Worker → SwitchBot API → Grow lights
JMA → Worker scheduled task → D1 weather observations
```

- `src/main.cpp`: initialization order and main loop
- `include/firmware_config.h`: pins, intervals, retry policy, firmware version
- `src/sensor_manager.cpp`: sensor initialization and independent measurements
- `src/measurement_controller.cpp`: sampling schedule, failure policy, record creation
- `src/record_codec.cpp`: LittleFS record and Cloudflare JSON serialization
- `src/ring_storage.cpp`: ring buffer and acknowledgement sidecar
- `src/cloud_upload.cpp`: live queue, bulk recovery, exponential backoff
- `src/network_manager.cpp`: Wi-Fi, NTP, ArduinoOTA

A failed sensor field does not discard valid fields from the same sampling cycle.
Missing and invalid values retain explicit quality states. A local record is marked
complete only after Cloudflare returns `accepted` or `duplicate`.

## Initial setup

1. Copy `include/secrets.example.h` to `include/secrets.h`.
2. Enter the Wi-Fi, OTA, and Cloudflare device credentials.
3. Run PlatformIO **Build** from VS Code.

`include/secrets.h` is excluded from Git and must never be committed.

## Build and OTA

```powershell
pio run -e esp32dev_ota

$env:ESP32_OTA_HOST = "device-hostname.local"
$env:ESP32_OTA_PASSWORD = "device-ota-password"
pio run -e esp32dev_ota -t upload
```

An IP address may be used instead of the OTA hostname. A regular firmware OTA does
not overwrite the entire LittleFS partition. Physical upload and hardware validation
are performed on site.

## Cloud operations documentation

- [Ingestion contract and device authentication](cloudflare-worker/INGESTION.md)
- [Measurement history API](cloudflare-worker/HISTORY_API.md)
- [Dashboard deployment and rollback](cloudflare-worker/DASHBOARD_DEPLOYMENT.md)
- [D1/R2 backup and recovery](cloudflare-worker/BACKUP_RECOVERY.md)
- [SwitchBot control](cloudflare-worker/CONTROL.md)
- [Cultivation journal and photos](cloudflare-worker/JOURNAL.md)
- [JMA observation archive](cloudflare-worker/WEATHER_ARCHIVE.md)
- [Discord alerts](cloudflare-worker/ALERTS.md)
- [Cloud platform roadmap](ROADMAP.md)
- [Multi-node integration guide](MULTI_NODE_INTEGRATION.md)
- [GitHub Project](https://github.com/users/Flammenwerfer41/projects/1)

The original monolithic Arduino sketch is preserved in `legacy_arduino/`.

## License

[MIT License](LICENSE)
