# ESP32 Hydroponics Environment Monitor

ESP32-WROOM-32D 기반 수경재배 환경 모니터링 프로젝트입니다.
현재 안정화 기준은 v8.0이며 PlatformIO와 Arduino framework를 사용합니다.

## 개발 환경

- Board: Espressif ESP32 Dev Module (`esp32dev`)
- Framework: Arduino
- Sensors: BME280, DS18B20 water temperature sensor
- I2C: SDA 18, SCL 19
- 1-Wire: DS18B20 data on GPIO 21 (4.7 kΩ pull-up to 3.3 V)
- Storage: LittleFS 30일 링버퍼
- Integrations: ThingSpeak (`field5`: water temperature), SwitchBot Plug Mini
- Dashboard: [GitHub Pages](https://flammenwerfer41.github.io/Hydroponics/)
- Features: ThingSpeak 원격 기록, GitHub Pages 대시보드, OTA

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

일반 펌웨어 OTA는 LittleFS 파티션을 덮어쓰지 않습니다. 기존 링버퍼를
보존하기 위해 **Upload Filesystem Image** 작업은 실행하지 않습니다.

## 호환성 주의사항

- `/sensor_ring.bin`의 `SensorRecord` 크기와 필드 순서를 변경하지 않습니다.
- LittleFS 30일 센서 링버퍼는 클라우드 장애 시의 로컬 백업으로 유지합니다.
- ESP 로컬 웹 대시보드와 `/api/current`, `/api/history`, `/download.csv`는
  클라우드 대시보드 전환에 따라 제거되었습니다.
- 기존 `/light_events.bin` 파일은 삭제하지 않지만 더 이상 읽거나 기록하지 않습니다.
- 기능 변경과 구조 리팩터링은 별도 커밋으로 분리합니다.

원본 Arduino 스케치는 `legacy_arduino/`에 보관되어 있습니다.

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다.
