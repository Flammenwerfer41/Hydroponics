# ESP32 Hydroponics Environment Monitor

ESP32-WROOM-32D 기반 수경재배 환경 모니터링 프로젝트입니다.
현재 개발 기준은 v8.2.0이며 PlatformIO와 Arduino framework를 사용합니다.

## 개발 환경

- Board: Espressif ESP32 Dev Module (`esp32dev`)
- Framework: Arduino
- Sensors: BME280, DS18B20 water temperature sensor
- I2C: SDA 18, SCL 19
- 1-Wire: DS18B20 data on GPIO 21 (4.7 kΩ pull-up to 3.3 V)
- Storage: LittleFS 30일 링버퍼
- Integrations: ThingSpeak, Cloudflare Workers/D1, SwitchBot Plug Mini
- Dashboard: [GitHub Pages](https://flammenwerfer41.github.io/Hydroponics/)
- Features: ThingSpeak·Cloudflare 병행 기록, GitHub Pages 대시보드, OTA

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
조명 이벤트 파일을 삭제하고 `/sensor_ring_v4.bin`을 생성합니다.

## 측정 및 저장 정책

- BME280 온도·습도·기압과 DS18B20 수온은 독립적으로 유효성을 판정합니다.
  한쪽 센서가 실패해도 정상 측정값은 LittleFS에 저장하고 ThingSpeak로 전송하며,
  실패한 필드만 비워 둡니다. 두 센서가 모두 실패한 주기만 건너뜁니다.
- BME280은 5회 연속 실패하면 ESP32를 재시작합니다. DS18B20은 단선 시 재시작보다
  재탐색이 유효하므로 매 측정 주기에 다시 탐색하면서 다른 센서의 동작을 계속합니다.
- `/sensor_ring_v4.bin`은 측정 시각, 부팅 ID, 순번, 펌웨어 버전, 센서값,
  SwitchBot 조명값과 목적지별 확인 비트를 포함한 48바이트 `SensorRecord`를
  사용하며 2분 간격으로 30일을 저장합니다.
- LittleFS 링버퍼는 클라우드 장애 시의 로컬 백업으로 유지합니다.
- ThingSpeak와 Cloudflare 성공 상태를 별도 비트로 관리합니다. 한 목적지의 장애가
  다른 목적지의 전송 완료 상태를 바꾸지 않습니다.
- ThingSpeak는 오래된 미확인 기록부터 최대 40건씩 복구하며, 링에 저장된
  `field1`~`field8`을 원래 측정 시각으로 전송합니다.
- Cloudflare는 장치별 Bearer 토큰으로 인증하고, `accepted` 또는 `duplicate` 응답을
  받은 기록만 완료 처리합니다. 최대 15건을 오래된 순서로 복구하며 실패 시
  30초에서 30분까지 지수 백오프와 지터를 적용합니다.
- Cloudflare 토큰이 비어 있으면 해당 목적지만 비활성화되고 ThingSpeak 동작은
  유지됩니다. D1과 장치 자격 증명을 준비한 뒤 `include/secrets.h`의
  `CLOUDFLARE_DEVICE_TOKEN`에 발급값을 넣습니다.
- Cloudflare HTTPS는 현재 `workers.dev` 인증서 체인의 GlobalSign ECC Root CA R4로
  서버를 검증합니다. 체인이 변경되면 전송은 안전하게 실패하고 기록은 LittleFS에
  남으므로, 새 루트 인증서를 반영한 펌웨어로 갱신해야 합니다.
- ESP 로컬 웹 대시보드와 `/api/current`, `/api/history`, `/download.csv`는
  클라우드 대시보드 전환에 따라 제거되었습니다.
- 기존 `/sensor_ring.bin`, `/sensor_ring_v2.bin`, `/sensor_ring_v3.bin`,
  `/light_events.bin`은 새 형식으로 처음 초기화할 때 삭제됩니다.
- 기능 변경과 구조 리팩터링은 별도 커밋으로 분리합니다.

## v8.2.0 병행 검증 절차

2026-08-09부터 운영 D1과 Worker 수집 API가 활성화되었고 v8.2.0 펌웨어가 OTA로
설치되었습니다. ThingSpeak는 중단하지 않았으며 두 목적지의 병행 검증 단계입니다.

1. 시리얼 로그에서 ThingSpeak 성공과 `Cloudflare acknowledged reading`을 각각
   확인합니다.
2. ThingSpeak와 D1 데이터를 2주간 병행 비교한 뒤 목적지 전환 여부를 판단합니다.
3. 검증 기간에 짧은 네트워크 단절을 만들어 오래된 기록부터 중복 없이 복구되는지
   확인합니다.

운영 프로비저닝을 다시 수행해야 할 때는
`cloudflare-worker/scripts/provision-device-credential.ps1`을 사용합니다. 스크립트는
토큰 원문을 출력하지 않고 Git에서 제외된 `include/secrets.h`와 `.wrangler` 작업 파일만
갱신합니다. 실행하면 기존 장치 토큰이 교체되므로 곧바로 D1 bootstrap과 펌웨어 OTA를
함께 수행해야 합니다.

Cloudflare API와 자격 증명 등록 방법은
[`cloudflare-worker/INGESTION.md`](cloudflare-worker/INGESTION.md)에 정리되어 있습니다.

원본 Arduino 스케치는 `legacy_arduino/`에 보관되어 있습니다.

클라우드 저장, 재배일지, 사진, 관리자 기능과 장래 확장 계획은
[Hydroponics Cloud Platform Roadmap](ROADMAP.md)에 정리되어 있습니다. 실제 작업의
우선순위와 진행 상태는 [GitHub Project](https://github.com/users/Flammenwerfer41/projects/1)에서 관리합니다.

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다.
