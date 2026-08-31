# 현재 수경재배 타워 시스템 구성도

이 문서는 현재 운영 중인 `home-lab / tower-01 / esp32-01`의 하드웨어 전원·배선과
소프트웨어 데이터·제어 흐름을 Mermaid로 정리합니다. 발코니 기상대처럼 아직
운영에 투입되지 않은 장치는 포함하지 않습니다.

[English version](TOWER_SYSTEM.en.md)

## 1. 하드웨어·전원·센서 배선

```mermaid
flowchart TB
  classDef mains fill:#fff1e8,stroke:#d66b32,color:#3b1d0f,stroke-width:2px
  classDef dc fill:#eef7ff,stroke:#3c7fb1,color:#102a3b
  classDef controller fill:#edf8f0,stroke:#33845a,color:#0d3321,stroke-width:2px
  classDef sensor fill:#f5f0ff,stroke:#7255a5,color:#271b42
  classDef warning fill:#fff6cf,stroke:#b58a00,color:#4b3900,stroke-dasharray:5 3

  subgraph AC["AC 100 V 전원 계통"]
    WALL["2구 벽 콘센트"]:::mains

    PLUG["SwitchBot Plug Mini<br/>조명 전원 ON/OFF·전력 측정"]:::mains
    LIGHTS["식물등 25 W × 3<br/>데이지체인 · 총 약 75 W"]:::mains

    STRIP["3구 멀티탭"]:::mains
    PUMP_PSU["펌프 어댑터<br/>AC 100 V → DC 12 V · 1 A"]:::dc
    PUMP["양액 순환펌프<br/>12 V · 3 W · 최대 200 L/h<br/>24시간 상시 가동"]:::dc
    ESP_PSU["ESP32 어댑터<br/>AC 100 V → DC 5 V · 3 A"]:::dc

    WALL -->|"상단 콘센트"| PLUG
    PLUG -->|"제어되는 AC 100 V"| LIGHTS
    WALL -->|"하단 콘센트"| STRIP
    STRIP -->|"AC 100 V"| PUMP_PSU
    PUMP_PSU -->|"DC 12 V"| PUMP
    STRIP -->|"AC 100 V"| ESP_PSU
  end

  subgraph NODE["타워 센서 노드"]
    ESP["30핀 NodeMCU-32S 호환 개발보드<br/>ESP32-WROOM-32D · CP2102 · Flash 4 MB"]:::controller
    ADAPTER["수동 GPIO 터미널 어댑터<br/>30핀 소켓·나사 터미널 인출"]:::controller

    RAIL_3V3["3.3 V 전원 레일"]:::dc
    RAIL_5V["VIN 5 V 전원 레일"]:::dc
    I2C_0["Primary I²C #0<br/>SDA GPIO23 · SCL GPIO22"]:::controller
    I2C_1["Secondary I²C #1<br/>SDA GPIO26 · SCL GPIO27"]:::controller
    ONEWIRE["1-Wire<br/>DATA GPIO15<br/>4.7 kΩ pull-up → 3.3 V"]:::controller
    GROUND["공통 GND"]:::dc

    BME["BME280<br/>기온·상대습도·기압"]:::sensor
    VEML["VEML7700<br/>조도 → 표시계층에서 추정 PPFD"]:::sensor
    SCD["SCD40<br/>CO₂ · BME280 기압 보정"]:::sensor
    WATER["DS18B20<br/>양액 수온 · 11-bit"]:::sensor

    ESP_PSU -->|"USB-C · DC 5 V"| ESP
    ESP -->|"30핀 장착"| ADAPTER
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

    DIRECT["운영 예외<br/>SCD40은 VIN 5 V로 구동하며<br/>별도 레벨시프터 없이 GPIO26/27에 직결"]:::warning
    DIRECT -.-> SCD
  end
```

SCD40 연결은 사용자가 비공식적인 ESP32 디지털 신호 5 V 내성 정보를 근거로
의도적으로 채택한 현재 운영 구성입니다. 공식 데이터시트 기반의 일반 권장 회로로
간주하지 않으며, 다른 장치에 그대로 복제할 때는 별도 검토가 필요합니다.

터미널 어댑터는 전압 변환이나 신호 증폭을 하지 않습니다. ESP32의 전원·GPIO를
암소켓과 나사식 터미널로 수동 인출해 납땜 없이 센서 배선을 확장하는 역할입니다.

## 2. 소프트웨어·데이터·제어 흐름

```mermaid
flowchart LR
  classDef device fill:#edf8f0,stroke:#33845a,color:#0d3321,stroke-width:2px
  classDef cloud fill:#eef7ff,stroke:#3c7fb1,color:#102a3b
  classDef data fill:#f5f0ff,stroke:#7255a5,color:#271b42
  classDef external fill:#fff1e8,stroke:#d66b32,color:#3b1d0f
  classDef user fill:#fffbe8,stroke:#a68a2e,color:#3d3310

  subgraph DEVICE["ESP32 펌웨어 v8.5.0"]
    SENSORS["BME280 · VEML7700<br/>SCD40 · DS18B20"]:::device
    MEASURE["센서별 독립 측정·품질 판정<br/>2분 주기"]:::device
    RING["LittleFS 링버퍼<br/>약 14일 로컬 보존"]:::data
    UPLOAD["HTTPS 단건·벌크 전송<br/>장치 토큰 · 중복 안전 재전송"]:::device
    OTA["Arduino OTA"]:::device

    SENSORS --> MEASURE --> RING --> UPLOAD
  end

  subgraph CF["Cloudflare 계층"]
    WORKER["Cloudflare Worker<br/>수집·조회·관리·제어 API"]:::cloud
    D1[("D1<br/>측정·기상·일지·제어 상태")]:::data
    R2[("R2<br/>일지 사진·D1 백업")]:::data
    ASSETS["Worker 정적 Assets<br/>공개·관리 대시보드"]:::cloud
    ACCESS["Cloudflare Access<br/>관리자 인증"]:::cloud
    ALERTS["경고 상태기계<br/>주의·경보·복구"]:::cloud

    WORKER --> D1
    D1 --> WORKER
    WORKER --> ASSETS
    D1 -->|"정기 백업"| R2
    WORKER -->|"사진 저장·조회"| R2
    D1 --> ALERTS
  end

  UPLOAD -->|"POST /v1/readings<br/>Bearer credential"| WORKER
  WORKER -.->|"accepted / duplicate"| RING

  JMA["JMA 공식 관측·도쿄지방 예보"]:::external
  JMA -->|"Worker 예약 수집"| WORKER

  DISCORD["Discord Webhook"]:::external
  ALERTS -->|"상태 진입·단계 상승·복구"| DISCORD

  USER["사용자 브라우저·모바일"]:::user
  USER -->|"공개 조회"| ASSETS
  USER -->|"관리 로그인"| ACCESS
  ACCESS -->|"인증된 관리 요청"| WORKER
  USER -->|"로컬 네트워크 OTA"| OTA

  SWITCHBOT["SwitchBot Cloud API"]:::external
  PLUG_SW["SwitchBot Plug Mini<br/>식물등 상태·전력·스케줄·명령"]:::external
  LIGHT_SW["식물등 3대"]:::external

  WORKER -->|"조회·ON/OFF·스케줄"| SWITCHBOT
  SWITCHBOT --> PLUG_SW --> LIGHT_SW
  PLUG_SW -->|"상태·소비전력"| WORKER
```

## 3. 계층별 책임

| 계층 | 주요 책임 | 장애 시 기대 동작 |
| --- | --- | --- |
| 센서·ESP32 | 측정, 필드별 유효성 판정, 타임스탬프, 로컬 보존 | 클라우드 장애 중에도 측정과 링버퍼 기록 지속 |
| LittleFS | 미전송·전송완료 레코드 보존, 오래된 순서의 백필 | 연결 복구 후 `accepted`/`duplicate` 응답을 확인하며 공백 복구 |
| Cloudflare Worker | 장치 인증, ingestion/history API, 경고, 일지, JMA, SwitchBot 제어 | 실패 중 ESP32는 로컬 기록; 원격 조회·제어는 일시 중단 |
| D1 | 측정값과 운영 메타데이터의 1차 데이터베이스 | R2 백업으로 복구 가능 |
| R2 | 일지 사진과 D1 정기 백업 | D1 실시간 수집과 분리된 장기 보존 |
| 대시보드 | 조회·시각화·관리 UI | 장치 측정과 로컬 보존에는 영향 없음 |
| SwitchBot | 식물등 상태·전력 조회와 스케줄·원격 명령 | 앱을 통한 독립 제어 경로 유지 |

## 4. 식별자와 운영 경계

| 구분 | 값 |
| --- | --- |
| site | `home-lab` |
| zone | `tower-01` |
| device | `esp32-01` |
| 조명 actuator | `tower-01-grow-light` |
| 시간대 | `Asia/Tokyo` |
| 측정 간격 | 약 120초 |

GitHub와 GitLab은 소스·문서·배포 이력을 보존하는 개발 계층이며 실시간 센서
데이터 경로에는 포함되지 않습니다. 비상용 GitHub/GitLab Pages 역시 운영
Cloudflare 대시보드와 분리된 정적 화면입니다.
