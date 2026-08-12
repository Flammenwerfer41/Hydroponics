# ESP32 Hydroponics Environment Monitor

ESP32-WROOM-32D 기반 수경재배 환경 모니터링 프로젝트입니다.
현재 개발 기준은 v8.4.0이며 PlatformIO와 Arduino framework를 사용합니다.

## 개발 환경

- Board: Espressif ESP32 Dev Module (`esp32dev`)
- Framework: Arduino
- Sensors: BME280, DS18B20 water temperature sensor
- I2C: SDA 18, SCL 19
- 1-Wire: DS18B20 data on GPIO 21 (4.7 kΩ pull-up to 3.3 V)
- Storage: LittleFS 14일 링버퍼
- Integrations: Cloudflare Workers/D1, SwitchBot Plug Mini·Hub Mini
- Dashboard: [Cloudflare Worker](https://hydroponics-jma-weather.flammenwerfer41.workers.dev/)
- Emergency mirror: [GitHub Pages](https://flammenwerfer41.github.io/Hydroponics/)
- Features: Cloudflare 단독 기록, 공개·관리 대시보드, 재배일지와 사진,
  JMA 실측 보관, Discord 경고, SwitchBot 제어, D1/R2 백업, OTA

## 현재 운영 기준

- 운영 펌웨어: v8.4.0
- 센서 주기: 2분
- 원격 측정 저장소: Cloudflare D1
- 장애 시 로컬 보존: LittleFS 14일 링버퍼
- 조명 상태·전력·스케줄과 에어컨 명령: Cloudflare Worker → SwitchBot
- 기상 자료: JMA 실측 장기 보관, 도쿄지방 최신 예보 1건 캐시
- 관리자 인증: Cloudflare Access
- 사진과 정기 백업: Cloudflare R2
- 비상용 정적 화면: GitHub Pages와 GitLab Pages

ThingSpeak 송신과 조회는 2026-08-09부터 종료되었습니다. 과거 데이터는 D1으로
이관되었으며, ESP32·대시보드·일일 보고서는 현재 Cloudflare 경로만 사용합니다.

## 처음 설정

1. `include/secrets.example.h`를 `include/secrets.h`로 복사합니다.
2. `include/secrets.h`의 자리표시자를 실제 값으로 교체합니다.
3. VS Code에서 PlatformIO의 **Build**를 실행합니다.

`include/secrets.h`는 `.gitignore`에 등록되어 있으므로 Git에 포함하면 안 됩니다.

## OTA 업데이트

ESP32와 PC가 같은 네트워크에 연결된 상태에서 PlatformIO Core CLI
터미널을 열고 다음 명령을 실행합니다.

```powershell
$env:ESP32_OTA_HOST = "장치의 OTA 호스트명.local"
$env:ESP32_OTA_PASSWORD = "장치의 OTA 비밀번호"
pio run -e esp32dev_ota
pio run -e esp32dev_ota -t upload
```

OTA 호스트명 대신 장치의 IP 주소를 사용할 수도 있습니다. 환경변수는
현재 터미널 세션에만 유지되며 Git에 저장되지 않습니다.

일반 펌웨어 OTA는 LittleFS 파티션 전체를 덮어쓰지 않습니다. 다만 수온을
포함하는 새 저장 형식으로 전환한 펌웨어를 처음 실행하면 기존 센서 링버퍼와
조명 이벤트 파일을 삭제하고 `/sensor_ring_v8.bin`을 생성합니다. v8.4.0은 v8.3.0의
40바이트 센서 링과 승인 사이드카를 그대로 사용하므로 OTA 시 기존 데이터가 유지됩니다.

## 측정 및 저장 정책

- BME280 온도·습도·기압과 DS18B20 수온은 독립적으로 유효성을 판정합니다.
  한쪽 센서가 실패해도 정상 측정값은 LittleFS에 저장하고 Cloudflare로 전송하며,
  실패한 필드만 비워 둡니다. 두 센서가 모두 실패한 주기만 건너뜁니다.
- BME280은 5회 연속 실패하면 ESP32를 재시작합니다. DS18B20은 단선 시 재시작보다
  재탐색이 유효하므로 매 측정 주기에 다시 탐색하면서 다른 센서의 동작을 계속합니다.
- `/sensor_ring_v8.bin`은 측정 시각, 부팅 ID, 순번, 펌웨어 버전, 물리 센서값과
  Cloudflare 확인 비트를 포함한 40바이트 `SensorRecord`를
  사용하며 2분 간격으로 14일을 저장합니다. LittleFS의 copy-on-write를 고려해
  링 파일 두 배와 128KB 여유 공간이 파티션에 들어오는지도 부팅 시 검증합니다.
- LittleFS 링버퍼는 클라우드 장애 시의 로컬 백업으로 유지합니다.
- Cloudflare는 장치별 Bearer 토큰으로 인증하고, `accepted` 또는 `duplicate` 응답을
  받은 기록만 완료 처리합니다. 최대 15건을 오래된 순서로 복구하며 실패 시
  30초에서 30분까지 지수 백오프와 지터를 적용합니다.
- Cloudflare 토큰이 비어 있으면 전송 기록은 LittleFS에 미완료 상태로 남습니다.
  D1과 장치 자격 증명을 준비한 뒤 `include/secrets.h`의
  `CLOUDFLARE_DEVICE_TOKEN`에 발급값을 넣습니다.
- Cloudflare HTTPS는 현재 `workers.dev` 인증서 체인의 GlobalSign ECC Root CA R4로
  서버를 검증합니다. 체인이 변경되면 전송은 안전하게 실패하고 기록은 LittleFS에
  남으므로, 새 루트 인증서를 반영한 펌웨어로 갱신해야 합니다.
- ESP 로컬 웹 대시보드와 `/api/current`, `/api/history`, `/download.csv`는
  클라우드 대시보드 전환에 따라 제거되었습니다.
- SwitchBot 토큰·서명·상태 조회도 ESP32에서 제거되었습니다. Worker가 조명 상태와
  전력을 별도 주기로 기록하고 스케줄 및 관리자 명령을 처리합니다.
- 기존 `/sensor_ring.bin`, `/sensor_ring_v2.bin`, `/sensor_ring_v3.bin`,
  `/light_events.bin`은 새 형식으로 처음 초기화할 때 삭제됩니다.
- 기능 변경과 구조 리팩터링은 별도 커밋으로 분리합니다.

승인 상태는 `/sensor_ack_v1.bin` 사이드카에 슬롯당 1바이트로 저장합니다. 따라서
Cloudflare 승인 갱신이 대형 센서 링을 복사-기록하지 않습니다.

## 펌웨어 구조

v8.4.0의 3차 리팩터링은 기능과 저장 형식을 바꾸지 않고 책임을 다음처럼
분리했습니다.

- `src/main.cpp`: 초기화 순서와 메인 루프만 조정
- `include/firmware_config.h`: 핀, 주기, 재시도 간격과 펌웨어 버전
- `src/sensor_manager.cpp`: BME280·DS18B20 초기화와 독립 측정
- `src/measurement_controller.cpp`: 2분 주기, 실패 정책과 측정 레코드 생성
- `src/record_codec.cpp`: LittleFS 레코드와 Cloudflare JSON 직렬화
- `src/ring_storage.cpp`: 14일 링버퍼와 승인 사이드카
- `src/cloud_upload.cpp`: 실시간 큐, 벌크 복구와 백오프
- `src/network_manager.cpp`: Wi-Fi, NTP, ArduinoOTA와 네트워크 서비스

`main.cpp`에서 각 책임을 분리했기 때문에 향후 센서가 늘어나도 저장·전송·OTA
로직을 동시에 수정하지 않고 단계별로 확장할 수 있습니다.

## v8.4.0 클라우드 제어 구조

ESP32는 BME280·DS18B20과 자체 Wi-Fi 상태만 수집합니다. 조명 상태·전력 조회,
07:00 ON / 21:00 OFF 스케줄, 수동 조작과 에어컨 명령은 Cloudflare Worker가
SwitchBot OpenAPI를 통해 담당합니다. 에어컨은 적외선 장치이므로 실제 상태가 아니라
마지막 명령만 표시합니다.

관리 화면은 `/admin/`에 있으며 Cloudflare Access로 보호합니다. 공개 센서 화면은
`/`에서 그대로 제공됩니다. 운영 및 보안 설정은
[`cloudflare-worker/CONTROL.md`](cloudflare-worker/CONTROL.md)를 참조하십시오.

운영 프로비저닝을 다시 수행해야 할 때는
`cloudflare-worker/scripts/provision-device-credential.ps1`을 사용합니다. 스크립트는
토큰 원문을 출력하지 않고 Git에서 제외된 `include/secrets.h`와 `.wrangler` 작업 파일만
갱신합니다. 실행하면 기존 장치 토큰이 교체되므로 곧바로 D1 bootstrap과 펌웨어 OTA를
함께 수행해야 합니다.

Cloudflare API와 자격 증명 등록 방법은
[`cloudflare-worker/INGESTION.md`](cloudflare-worker/INGESTION.md)에 정리되어 있습니다.
측정 이력 조회·내보내기는 [`cloudflare-worker/HISTORY_API.md`](cloudflare-worker/HISTORY_API.md),
D1/R2 백업과 복구 훈련은 [`cloudflare-worker/BACKUP_RECOVERY.md`](cloudflare-worker/BACKUP_RECOVERY.md)를
참조하십시오. 대시보드 배포와 롤백은
[`cloudflare-worker/DASHBOARD_DEPLOYMENT.md`](cloudflare-worker/DASHBOARD_DEPLOYMENT.md)에
정리되어 있습니다. 재배일지와 사진은
[`cloudflare-worker/JOURNAL.md`](cloudflare-worker/JOURNAL.md), JMA 보관은
[`cloudflare-worker/WEATHER_ARCHIVE.md`](cloudflare-worker/WEATHER_ARCHIVE.md), 경고 규칙과
Discord 전송은 [`cloudflare-worker/ALERTS.md`](cloudflare-worker/ALERTS.md)를 참조하십시오.

## 다음 센서 확장

배송 예정인 SCD40(CO₂)과 VEML7700(조도)은 하드웨어 도착 후 다음 순서로
추가합니다.

1. 실제 브레이크아웃 보드의 3.3V 전원 호환성과 I2C 풀업 구성을 확인합니다.
2. 기존 SDA 18·SCL 19 버스에서 BME280과 함께 주소 충돌 및 장시간 안정성을
   검증합니다.
3. 센서 드라이버와 측정 품질만 먼저 추가하고 저장·전송 규격 변경은 별도
   커밋으로 진행합니다.
4. D1 계약과 대시보드에 `co2_concentration`과 `illuminance`를 추가합니다.
5. 조도에서 PPFD로의 변환은 식물등과 실제 설치 위치에서 얻은 보정값이 준비된
   뒤 파생 지표로 도입합니다.

현재 ESP32, BME280, DS18B20, 수직 타워와 SwitchBot 구성은 유지합니다. 새 센서가
도착하기 전에는 핀 연결이나 운영 펌웨어의 측정 규격을 미리 바꾸지 않습니다.

원본 Arduino 스케치는 `legacy_arduino/`에 보관되어 있습니다.

클라우드 저장, 재배일지, 사진, 관리자 기능과 장래 확장 계획은
[Hydroponics Cloud Platform Roadmap](ROADMAP.md)에 정리되어 있습니다. 실제 작업의
우선순위와 진행 상태는 [GitHub Project](https://github.com/users/Flammenwerfer41/projects/1)에서 관리합니다.

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다.
