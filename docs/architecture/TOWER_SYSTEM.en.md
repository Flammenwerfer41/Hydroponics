# Current Hydroponics Tower System Architecture

This document describes the hardware power and wiring architecture and the software data and
control flows of the production `home-lab / tower-01 / esp32-01` system. It excludes devices
that have not entered production, such as the planned balcony weather station.

[한국어판](TOWER_SYSTEM.md)

## 1. Hardware, power, and sensor wiring

```mermaid
flowchart TB
  classDef mains fill:#fff1e8,stroke:#d66b32,color:#3b1d0f,stroke-width:2px
  classDef dc fill:#eef7ff,stroke:#3c7fb1,color:#102a3b
  classDef controller fill:#edf8f0,stroke:#33845a,color:#0d3321,stroke-width:2px
  classDef sensor fill:#f5f0ff,stroke:#7255a5,color:#271b42
  classDef warning fill:#fff6cf,stroke:#b58a00,color:#4b3900,stroke-dasharray:5 3

  subgraph AC["AC 100 V power distribution"]
    WALL["Two-outlet wall receptacle"]:::mains

    PLUG["SwitchBot Plug Mini<br/>Light power control and metering"]:::mains
    LIGHTS["Three 25 W grow lights<br/>Daisy-chained · about 75 W total"]:::mains

    STRIP["Three-outlet power strip"]:::mains
    PUMP_PSU["Pump adapter<br/>AC 100 V → DC 12 V · 1 A"]:::dc
    PUMP["Nutrient circulation pump<br/>12 V · 3 W · up to 200 L/h<br/>Continuous 24-hour operation"]:::dc
    ESP_PSU["ESP32 adapter<br/>AC 100 V → DC 5 V · 3 A"]:::dc

    WALL -->|"Upper outlet"| PLUG
    PLUG -->|"Switched AC 100 V"| LIGHTS
    WALL -->|"Lower outlet"| STRIP
    STRIP -->|"AC 100 V"| PUMP_PSU
    PUMP_PSU -->|"DC 12 V"| PUMP
    STRIP -->|"AC 100 V"| ESP_PSU
  end

  subgraph NODE["Tower sensor node"]
    ESP["30-pin NodeMCU-32S-compatible board<br/>ESP32-WROOM-32D · CP2102 · 4 MB flash"]:::controller
    ADAPTER["Passive GPIO terminal adapter<br/>30-pin sockets and screw terminals"]:::controller

    RAIL_3V3["3.3 V power rail"]:::dc
    RAIL_5V["VIN 5 V power rail"]:::dc
    I2C_0["Primary I²C #0<br/>SDA GPIO23 · SCL GPIO22"]:::controller
    I2C_1["Secondary I²C #1<br/>SDA GPIO26 · SCL GPIO27"]:::controller
    ONEWIRE["1-Wire<br/>DATA GPIO15<br/>4.7 kΩ pull-up → 3.3 V"]:::controller
    GROUND["Common ground"]:::dc

    BME["BME280<br/>Air temperature · RH · pressure"]:::sensor
    VEML["VEML7700<br/>Illuminance → estimated PPFD in presentation layer"]:::sensor
    SCD["SCD40<br/>CO₂ · BME280 pressure compensation"]:::sensor
    WATER["DS18B20<br/>Nutrient temperature · 11-bit"]:::sensor

    ESP_PSU -->|"USB-C · DC 5 V"| ESP
    ESP -->|"30-pin mounting"| ADAPTER
    ADAPTER --> RAIL_3V3
    ADAPTER --> RAIL_5V
    ADAPTER --> I2C_0
    ADAPTER --> I2C_1
    ADAPTER --> ONEWIRE
    ADAPTER --> GROUND

    RAIL_3V3 --> BME
    RAIL_3V3 --> VEML
    RAIL_3V3 --> WATER
    RAIL_5V --> SCD

    I2C_0 --> BME
    I2C_0 --> VEML
    I2C_1 --> SCD
    ONEWIRE --> WATER
    GROUND --> BME
    GROUND --> VEML
    GROUND --> SCD
    GROUND --> WATER

    DIRECT["Operating exception<br/>SCD40 is powered from VIN 5 V<br/>and connects directly to GPIO26/27"]:::warning
    DIRECT -.-> SCD
  end
```

The direct SCD40 connection is a deliberate production configuration selected by the owner based
on informal information about ESP32 digital-signal 5 V tolerance. It is not presented as a
general-purpose reference circuit based on the official datasheet and should be reviewed before
being replicated in another device.

The terminal adapter performs no voltage translation or signal amplification. It passively exposes
the ESP32 power and GPIO pins through additional sockets and screw terminals so sensors can be
wired without soldering.

## 2. Software, data, and control flow

```mermaid
flowchart LR
  classDef device fill:#edf8f0,stroke:#33845a,color:#0d3321,stroke-width:2px
  classDef cloud fill:#eef7ff,stroke:#3c7fb1,color:#102a3b
  classDef data fill:#f5f0ff,stroke:#7255a5,color:#271b42
  classDef external fill:#fff1e8,stroke:#d66b32,color:#3b1d0f
  classDef user fill:#fffbe8,stroke:#a68a2e,color:#3d3310

  subgraph DEVICE["ESP32 firmware v8.5.0"]
    SENSORS["BME280 · VEML7700<br/>SCD40 · DS18B20"]:::device
    MEASURE["Independent sensor sampling and quality checks<br/>Every two minutes"]:::device
    RING["LittleFS ring buffer<br/>About 14 days of local retention"]:::data
    UPLOAD["HTTPS single and bulk upload<br/>Device credential · idempotent retry"]:::device
    OTA["Arduino OTA"]:::device

    SENSORS --> MEASURE --> RING --> UPLOAD
  end

  subgraph CF["Cloudflare layer"]
    WORKER["Cloudflare Worker<br/>Ingestion · query · admin · control APIs"]:::cloud
    D1[("D1<br/>Telemetry · weather · journal · control state")]:::data
    R2[("R2<br/>Journal photos · D1 backups")]:::data
    ASSETS["Worker static assets<br/>Public and admin dashboards"]:::cloud
    ACCESS["Cloudflare Access<br/>Administrator authentication"]:::cloud
    ALERTS["Alert state machine<br/>Advisory · warning · recovery"]:::cloud

    WORKER --> D1
    D1 --> WORKER
    WORKER --> ASSETS
    D1 -->|"Scheduled backup"| R2
    WORKER -->|"Photo storage and retrieval"| R2
    D1 --> ALERTS
  end

  UPLOAD -->|"POST /v1/readings<br/>Bearer credential"| WORKER
  WORKER -.->|"accepted / duplicate"| RING

  JMA["Official JMA observations<br/>Tokyo regional forecast"]:::external
  JMA -->|"Scheduled Worker fetch"| WORKER

  DISCORD["Discord webhook"]:::external
  ALERTS -->|"State entry · escalation · recovery"| DISCORD

  USER["User browser or mobile device"]:::user
  USER -->|"Public query"| ASSETS
  USER -->|"Admin sign-in"| ACCESS
  ACCESS -->|"Authenticated admin request"| WORKER
  USER -->|"Local-network OTA"| OTA

  SWITCHBOT["SwitchBot Cloud API"]:::external
  PLUG_SW["SwitchBot Plug Mini<br/>Light state · power · schedule · commands"]:::external
  LIGHT_SW["Three grow lights"]:::external

  WORKER -->|"Query · ON/OFF · schedule"| SWITCHBOT
  SWITCHBOT --> PLUG_SW --> LIGHT_SW
  PLUG_SW -->|"State and power"| WORKER
```

## 3. Layer responsibilities

| Layer | Primary responsibilities | Expected behavior during an outage |
| --- | --- | --- |
| Sensors and ESP32 | Sampling, per-field validation, timestamps, local retention | Sampling and ring-buffer writes continue during a cloud outage |
| LittleFS | Retain pending and acknowledged records; backfill oldest first | Recover gaps after connectivity returns, confirming `accepted` or `duplicate` |
| Cloudflare Worker | Device authentication, ingestion/history APIs, alerts, journal, JMA, SwitchBot control | ESP32 keeps local records; remote query and control pause temporarily |
| D1 | Primary telemetry and operational metadata database | Recoverable from R2 backups |
| R2 | Journal photos and scheduled D1 backups | Long-term storage separated from live D1 ingestion |
| Dashboard | Query, visualization, and administrative UI | Does not affect device sampling or local retention |
| SwitchBot | Grow-light state and power queries, schedules, and remote commands | SwitchBot mobile app remains an independent control path |

## 4. Identity and operational boundary

| Category | Value |
| --- | --- |
| site | `home-lab` |
| zone | `tower-01` |
| device | `esp32-01` |
| light actuator | `tower-01-grow-light` |
| time zone | `Asia/Tokyo` |
| sampling interval | Approximately 120 seconds |

GitHub and GitLab form the development layer that preserves source code, documentation, and
deployment history; they are not part of the live telemetry path. The emergency GitHub/GitLab
Pages mirrors are also static views separate from the production Cloudflare dashboard.
