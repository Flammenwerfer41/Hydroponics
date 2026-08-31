# ESP32 수경재배 환경 모니터

[![English README](https://img.shields.io/badge/README-English-0d815c)](README.md)

ESP32-WROOM-32D 기반 수경재배 환경 관측·기록·제어 프로젝트입니다. 센서 노드는
네트워크 장애 중에도 측정값을 로컬에 보존하며, Cloudflare Worker와 D1을 통해
공개 대시보드, 재배일지, 경고 및 SwitchBot 조명 제어 기능을 제공합니다.

- **운영 펌웨어:** v8.5.0
- **프레임워크:** PlatformIO · Arduino
- **운영 대시보드:** [Cloudflare Worker](https://hydroponics-jma-weather.flammenwerfer41.workers.dev/)
- **비상 미러:** [GitHub Pages](https://flammenwerfer41.github.io/Hydroponics/)
- **시스템 구성도:** [한국어](docs/architecture/TOWER_SYSTEM.md) · [English](docs/architecture/TOWER_SYSTEM.en.md)

## 주요 기능

- BME280 기온·습도·기압, DS18B20 양액 수온, SCD40 CO₂, VEML7700 조도 측정
- 원시 lux를 보존하고 버전이 지정된 계수로 대시보드에서 추정 PPFD 표시
- 약 2분 측정 주기와 LittleFS 약 14일 링버퍼
- 네트워크 복구 후 오래된 레코드부터 중복 없이 단건·벌크 백필
- Cloudflare Worker 장치 인증, D1 이력, R2 사진·정기 백업
- 공개·관리 대시보드, Cloudflare Access, 재배일지와 WebP 사진
- JMA 공식 실측 장기 보관과 도쿄지방 예보
- 상태 기반 Discord 주의·경보·복구 알림
- SwitchBot Plug Mini 조명 상태·전력·스케줄·원격 명령
- Arduino OTA

ThingSpeak 송신과 조회는 2026-08-09부터 종료되었습니다. 과거 자료는 D1으로
이관되었으며 현재 ESP32, 대시보드와 보고서는 Cloudflare 경로를 사용합니다.

## 하드웨어

| 구성요소 | 전원·연결 | 역할 |
| --- | --- | --- |
| ESP32 | NodeMCU-32S 호환 30핀 보드, USB-C 5V | 측정·로컬 보존·전송·OTA |
| BME280 | 3.3V, SDA 23 / SCL 22 | 기온·상대습도·기압 |
| VEML7700 | 3.3V, SDA 23 / SCL 22 | 조도 |
| SCD40 | VIN 5V, SDA 26 / SCL 27 | CO₂, BME280 기압 보정 |
| DS18B20 | 3.3V, DATA 15, 4.7kΩ 풀업 | 양액 수온 |

BME280과 VEML7700은 primary I²C 버스를 공유하고 SCD40은 secondary I²C 버스를
사용합니다. 현재 운영 장치의 SCD40은 VIN 5V 전원 상태에서 별도 레벨시프터 없이
GPIO26/27에 직접 연결되어 있습니다. 이는 사용자 승인 운영 예외이며 일반적인
공식 권장 회로로 간주하지 않습니다.

AC/DC 전원, 순환펌프, 식물등 및 전체 데이터 흐름은
[현재 타워 시스템 구성도](docs/architecture/TOWER_SYSTEM.md)를 참조하십시오.

## 소프트웨어 책임 분리

```text
센서 → ESP32 → LittleFS → Cloudflare Worker → D1 → 대시보드·경고
                                              └→ R2 사진·백업
관리자 → Cloudflare Access → Worker → SwitchBot API → 식물등
JMA → Worker 예약 작업 → D1 기상 관측
```

- `src/main.cpp`: 초기화와 메인 루프
- `include/firmware_config.h`: 핀, 주기, 재시도와 펌웨어 버전
- `src/sensor_manager.cpp`: 센서 초기화와 독립 측정
- `src/measurement_controller.cpp`: 측정 주기, 실패 정책과 레코드 생성
- `src/record_codec.cpp`: LittleFS 레코드와 Cloudflare JSON 직렬화
- `src/ring_storage.cpp`: 링버퍼와 승인 사이드카
- `src/cloud_upload.cpp`: 실시간 큐, 벌크 복구와 백오프
- `src/network_manager.cpp`: Wi-Fi, NTP, ArduinoOTA

센서의 일부 필드가 실패해도 정상 필드는 버리지 않습니다. 결측·비정상 필드는
품질 상태로 구분하며, Cloudflare가 `accepted` 또는 `duplicate`로 확인한 레코드만
로컬에서 전송 완료 처리합니다.

## 처음 설정

1. `include/secrets.example.h`를 `include/secrets.h`로 복사합니다.
2. Wi-Fi, OTA와 Cloudflare 장치 자격 증명을 입력합니다.
3. VS Code에서 PlatformIO의 **Build**를 실행합니다.

`include/secrets.h`는 Git에서 제외되며 저장소에 커밋하면 안 됩니다.

## 빌드와 OTA

```powershell
pio run -e esp32dev_ota

$env:ESP32_OTA_HOST = "장치의 OTA 호스트명.local"
$env:ESP32_OTA_PASSWORD = "장치의 OTA 비밀번호"
pio run -e esp32dev_ota -t upload
```

OTA 호스트 대신 IP 주소를 사용할 수 있습니다. 일반 펌웨어 OTA는 LittleFS
파티션 전체를 덮어쓰지 않습니다. 실제 업로드와 하드웨어 검증은 현장에서
수행합니다.

## 클라우드 운영 문서

- [수집 계약과 장치 인증](cloudflare-worker/INGESTION.md)
- [측정 이력 API](cloudflare-worker/HISTORY_API.md)
- [대시보드 배포와 롤백](cloudflare-worker/DASHBOARD_DEPLOYMENT.md)
- [D1/R2 백업과 복구](cloudflare-worker/BACKUP_RECOVERY.md)
- [SwitchBot 제어](cloudflare-worker/CONTROL.md)
- [재배일지와 사진](cloudflare-worker/JOURNAL.md)
- [JMA 관측 보관](cloudflare-worker/WEATHER_ARCHIVE.md)
- [Discord 경고](cloudflare-worker/ALERTS.md)
- [클라우드 플랫폼 로드맵](ROADMAP.md)
- [다중 환경 노드 통합 지침](MULTI_NODE_INTEGRATION.md)
- [GitHub Project](https://github.com/users/Flammenwerfer41/projects/1)

원본 Arduino 단일 스케치는 `legacy_arduino/`에 보관되어 있습니다.

## 라이선스

[MIT License](LICENSE)
