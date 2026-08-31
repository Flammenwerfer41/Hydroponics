# 수경재배·발코니 기상대 통합 데이터 및 운영 지침

## 1. 문서 목적

이 문서는 현재 수경재배 시스템과 별도로 개발 중인 발코니 기상대를 하나의
Cloudflare 데이터 플랫폼에서 운영하기 위한 기준을 정의합니다. 아직 기상대의
구체적인 센서와 핀이 확정되지 않아도 장치 식별, 데이터 의미, 인증, 저장,
조회, 경고와 장애 복구 방식을 먼저 고정하는 것이 목적입니다.

이 문서는 설계 기준이며, 작성 시점에 운영 Worker, D1 스키마 또는 수경재배
펌웨어를 변경하지 않습니다.

### 현재 확정된 1차 범위

발코니 기상대의 1차 구성은 **BME280 한 개**이며 다음 세 물리량만 수집합니다.

- `air_temperature` (`degC`)
- `humidity` (`percent`)
- `pressure` (`hPa`)

풍속·풍향·강수·일사·UV는 현재 구현 대상이 아닙니다. 이 문서의 관련 metric과
집계 규칙은 장래 확장 시 이름과 의미가 뒤섞이지 않도록 남겨 둔 참고 설계입니다.
따라서 1차 도입에서는 신규 metric이나 특수 집계 기능을 추가할 필요가 없습니다.

## 2. 통합 원칙

1. **장치는 분리하고 데이터 계약만 공유합니다.** 수경재배 노드와 기상대는
   별도 펌웨어·자격 증명·로컬 버퍼를 사용합니다.
2. **같은 물리량은 같은 metric 이름과 단위를 사용합니다.** 실내외 구분을
   `indoor_temperature`, `outdoor_temperature` 같은 이름에 넣지 않고
   `device_id`와 `zone_id`로 구분합니다.
3. **장치가 아닌 서버가 장치 신원을 결정합니다.** payload가 임의의
   `device_id`를 주장하지 않으며 Bearer 자격 증명에 연결된 D1 레코드가 신원을
   결정합니다.
4. **원시 관측과 파생값을 구분합니다.** 센서가 직접 측정한 값은 보존하고,
   체감온도·이슬점·해면기압·강우 누계 같은 파생값은 계산 방법과 버전을
   명시합니다.
5. **한 센서의 실패가 다른 값을 버리게 하지 않습니다.** 결측은 필드별
   `null`과 quality로 표현합니다.
6. **업로드 지연과 측정 시각을 혼동하지 않습니다.** `measured_at`은 실제
   관측 시각, D1의 `received_at`은 서버 수신 시각입니다.
7. **기존 수경재배 운영을 기상대 개발에 종속시키지 않습니다.** 기상대 장애,
   배포 또는 자격 증명 회전이 타워 측정·조명·공조 제어에 영향을 주면 안 됩니다.

## 3. 목표 구조

```text
수경재배 ESP32 ── 장치 토큰 A ─┐
                               ├─ Cloudflare Worker ─ D1 ─ 대시보드/보고서/경고
발코니 기상대 ─── 장치 토큰 B ─┘                       └ R2 정기 백업

JMA 공식 관측 ─── Worker 주기 작업 ─ 별도 JMA 관측 테이블
```

발코니 관측값과 JMA 자료는 모두 외부 환경을 설명하지만 출처와 품질이 다릅니다.
발코니 값은 `readings`/`measurement_values`, JMA 값은 기존 JMA 관측 테이블에
계속 저장합니다. 두 출처를 한 행이나 같은 장치로 합치지 않습니다.

## 4. 식별자와 공간 모델

현재 운영 식별자는 유지하고 다음 항목만 추가하는 것을 권장합니다.

| 계층 | 현재 수경재배 | 발코니 기상대 권장값 | 규칙 |
| --- | --- | --- | --- |
| site | `home-lab` | `home-lab` | 같은 주거 환경이므로 공유 |
| zone | `tower-01` | `balcony-01` | 물리적·운영 경계를 분리 |
| device | `esp32-01` | `balcony-weather-01` | 역할을 알 수 있는 불변 ID |
| credential | `esp32-01-primary` | `balcony-weather-01-primary` | 장치별 독립 토큰 |

권장 zone 속성:

- `name`: `Balcony weather station`
- `kind`: `weather_station`
- `position_label`: 정확한 주소 대신 `Apartment balcony` 정도의 비공개 운영명

ID는 설치 위치나 보드가 바뀌어도 과거 이력과 연결되므로 한 번 운영을 시작한 뒤
이름을 바꾸지 않습니다. 보드 교체는 같은 역할을 이어받으면 새 credential과
새 firmware 기록으로 관리하고, 완전히 독립된 관측점이면 새 device ID를 만듭니다.

### 운영 D1에 추가할 권장 레코드

기존 타워 레코드는 그대로 유지하고 아래 행만 추가합니다. `created_at`과
`updated_at`은 실제 등록 시각의 UTC ISO 8601 값으로 채우며, credential digest는
별도 생성 도구가 만든 SHA-256 값으로 대체합니다.

#### `zones`

| id | site_id | name | kind | position_label |
| --- | --- | --- | --- | --- |
| `balcony-01` | `home-lab` | `Balcony weather station` | `weather_station` | `Apartment balcony` |

#### `devices`

| id | site_id | zone_id | name | kind | hardware_model | active |
| --- | --- | --- | --- | --- | --- | ---: |
| `balcony-weather-01` | `home-lab` | `balcony-01` | `Balcony weather monitor` | `esp32` | 실제 보드 모델 | 1 |

`firmware_release_id`는 기상대 펌웨어 릴리스를 등록한 뒤 연결하고, 준비 전에는
`NULL`로 둘 수 있습니다.

#### `sensors`

| id | device_id | zone_id | name | metric | model | connection | active |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| `balcony-01-bme280-temperature` | `balcony-weather-01` | `balcony-01` | `Balcony air temperature` | `air_temperature` | `BME280` | 실제 I2C 핀 | 1 |
| `balcony-01-bme280-humidity` | `balcony-weather-01` | `balcony-01` | `Balcony air humidity` | `humidity` | `BME280` | 실제 I2C 핀 | 1 |
| `balcony-01-bme280-pressure` | `balcony-weather-01` | `balcony-01` | `Balcony air pressure` | `pressure` | `BME280` | 실제 I2C 핀 | 1 |

하나의 BME280이 세 값을 측정하지만 metric별 센서 레코드를 두는 현재 카탈로그
방식을 따릅니다. 이를 통해 metric별 설치·교정·폐기 이력을 독립적으로 조회할 수
있습니다.

#### `device_credentials`

| id | device_id | label | secret_sha256 | revoked_at |
| --- | --- | --- | --- | --- |
| `balcony-weather-01-primary` | `balcony-weather-01` | `firmware primary` | 생성된 64자리 SHA-256 digest | `NULL` |

원문 토큰은 D1이나 Git에 저장하지 않습니다. 기상대 펌웨어의 ignored secrets 파일에만
보관하고, 타워의 `esp32-01-primary` 토큰을 재사용하지 않습니다.

### 저장되는 측정 레코드의 관계

측정 한 회는 `readings` 한 행과 `measurement_values` 세 행으로 저장됩니다.

| 테이블 | 주요 식별값 | 예시 |
| --- | --- | --- |
| `readings` | `device_id` | `balcony-weather-01` |
| `readings` | `reading_id` | `<boot_id>:<sequence>` |
| `measurement_values` | `metric` | `air_temperature`, `humidity`, `pressure` |
| `measurement_values` | `unit` | `degC`, `percent`, `hPa` |
| `measurement_values` | `quality` | `valid`, `missing`, `invalid` 등 |

`site_id`와 `zone_id`를 매 측정 행에 중복 저장하지 않고
`readings.device_id → devices.site_id/zone_id` 조인으로 얻습니다. 기존 타워는
`esp32-01 → home-lab/tower-01`, 기상대는
`balcony-weather-01 → home-lab/balcony-01`로 분리됩니다. 이는 정규화된 현재
스키마의 의도된 구조이므로 D1 마이그레이션은 필요하지 않습니다.

## 5. 공통 전송 포맷

기상대도 현재 `POST /v1/readings`와 `POST /v1/readings/bulk` 계약을 그대로
사용합니다. 기존 envelope 구조를 바꾸지 않으므로 payload `schema_version`은
당분간 1을 유지할 수 있습니다.

```json
{
  "schema_version": 1,
  "reading_id": "a1b2c3d4e5f60708:42",
  "boot_id": "a1b2c3d4e5f60708",
  "sequence": 42,
  "measured_at": "2026-09-01T06:00:00+09:00",
  "firmware_version": "1.0.0",
  "reset_reason": "power_on",
  "values": {
    "air_temperature": 27.4,
    "humidity": 71.2,
    "pressure": 1006.8,
    "wind_speed": 1.7,
    "wind_gust": 3.4,
    "wind_direction": 225,
    "precipitation_increment": 0.0,
    "wifi_rssi": -61
  },
  "quality": {
    "air_temperature": "valid",
    "humidity": "valid",
    "wind_direction": "valid"
  },
  "diagnostics": {}
}
```

### 식별과 중복 방지

- `boot_id`: 부팅 때 한 번 생성하는 8~64자의 충분히 무작위인 값
- `sequence`: 한 부팅 안에서 0부터 증가하는 정수
- `reading_id`: 권장 형식 `<boot_id>:<sequence>`
- `(device_id, reading_id)`와 `(device_id, boot_id, sequence)`가 중복을 차단
- 재전송 결과가 `accepted` 또는 `duplicate`일 때만 로컬 완료 처리
- 동일 reading ID에 다른 payload를 보내면 충돌로 처리하며 덮어쓰지 않음

장치 ID는 JSON에 넣지 않습니다. Worker가 Bearer 토큰의 SHA-256 digest를 조회해
`balcony-weather-01`로 결정합니다.

## 6. metric 명명·단위 규칙

### 기존 공통 metric

| metric | 단위 | 기상대 사용 | 비고 |
| --- | --- | --- | --- |
| `air_temperature` | `degC` | 권장 | 실내외는 장치/zone으로 구분 |
| `humidity` | `percent` | 권장 | 상대습도 |
| `pressure` | `hPa` | 권장 | 센서 위치의 현지기압 |
| `illuminance` | `lux` | 선택 | 일사량이나 PAR과 동일하지 않음 |
| `wifi_rssi` | `dBm` | 권장 | 장치 통신 진단 |

`pressure`는 별도 보정 없이 센서 고도의 현지기압을 의미합니다. 해면기압으로
환산한다면 원본을 덮어쓰지 않고 `sea_level_pressure` 같은 별도 파생 metric과
알고리즘 버전을 사용합니다.

### 기상대 신규 metric 후보

실제 센서가 확정된 항목만 Worker allowlist에 추가합니다.

| metric | 단위 | 값의 정의 | 권장 범위 예시 |
| --- | --- | --- | --- |
| `wind_speed` | `m/s` | 한 전송 주기의 평균 풍속 | 0~100 |
| `wind_gust` | `m/s` | 주기 내 짧은 구간 평균의 최댓값 | 0~150 |
| `wind_direction` | `deg` | 북=0, 동=90, 남=180, 서=270 | 0 이상 360 미만 |
| `precipitation_increment` | `mm` | 직전 관측 이후 새로 누적된 강수량 | 0 이상 |
| `solar_irradiance` | `W/m2` | 해당 센서가 실제 일사계를 사용할 때만 | 0~2000 |
| `uv_index` | `index` | 센서·알고리즘이 산출한 UV index | 0~30 |
| `supply_voltage` | `V` | 노드 입력 또는 배터리 전압 | 하드웨어별 정의 |
| `battery_state_of_charge` | `percent` | 검증된 추정기가 있을 때만 | 0~100 |

다음 원칙을 지킵니다.

- 단위는 metric 이름에 넣지 않습니다. `wind_speed_ms` 대신 `wind_speed`를 씁니다.
- 센서 모델명도 metric에 넣지 않습니다. 모델은 `sensors.model`에 기록합니다.
- `rainfall`, `rain`, `precipitation`을 혼용하지 않습니다.
- 누계와 증분을 혼동하지 않습니다. 일별 강수량은
  `precipitation_increment`의 유효값 합으로 계산합니다.
- 조도(lux)를 일사량(`W/m2`)이나 PPFD로 이름만 바꿔 저장하지 않습니다.
- 파생값에는 계산식, 계수, 적용 시작일과 버전을 둡니다.

새 metric을 추가할 때는 다음을 한 커밋에서 함께 변경합니다.

1. Worker `METRICS` allowlist와 물리 범위
2. ingestion·history·부분 결측 테스트
3. `INGESTION.md`의 metric 표
4. 대시보드나 보고서가 필요로 하는 조회 목록

metric 추가만으로 D1 테이블을 변경할 필요는 없습니다.

### 현재 계약에서 먼저 알아야 할 제약

현재 schema v1의 `values`는 metric 이름을 JSON key로 사용하고 D1의 기본키도
`(reading_pk, metric)`입니다. 따라서 **한 장치의 한 관측 레코드에는 같은 metric을
두 번 넣을 수 없습니다.** 외기 온도 센서가 하나인 일반적인 기상대에는 문제가
없지만, 같은 장치에서 차폐통 온도와 기판 내부 온도처럼 동일 물리량을 여러 개
보내려면 다음 중 하나를 먼저 결정해야 합니다.

- 서로 독립된 관측 장치라면 device를 분리
- 장치 내부 진단값이라면 의미가 다른 정식 metric으로 정의
- 같은 종류의 복수 센서를 장기 지원한다면 sensor ID를 포함하는 schema v2 설계

임시로 `air_temperature_2`, `temperature_new` 같은 이름을 만들지 않습니다.

또한 현재 `sensors`와 `sensor_calibrations`는 장치 카탈로그로 존재하지만 ingestion은
metric을 자동으로 특정 `sensor_id`에 연결하지 않습니다. 교정값을 서버에서 자동
적용하려면 metric→활성 sensor 매핑과 적용 버전 정책을 별도 기능으로 구현해야
합니다. 그 전까지 교정은 펌웨어 또는 명시적인 버전 지정 파생계층에서 수행합니다.

### metric별 집계 방식

온도에 적합한 평균이 모든 기상 metric에 적합하지는 않습니다. 현재 일반 history
집계는 min/max/mean을 제공하므로, 아래 특수 집계가 구현되기 전에는 강수와 풍향을
원시 이력으로만 검증합니다.

| metric | 시간·일간 대표 집계 |
| --- | --- |
| `air_temperature`, `humidity`, `pressure`, `wind_speed` | 유효값 평균·최소·최대 |
| `wind_gust` | 구간 최댓값 |
| `wind_direction` | sin/cos를 사용한 원형 평균; 단순 산술평균 금지 |
| `precipitation_increment` | 구간 합계; 평균값을 강수량으로 사용 금지 |
| `solar_irradiance` | 평균·최대와 시간적분을 구분 |

향후 Worker metric registry에는 단위와 범위뿐 아니라 `aggregation: mean|max|sum|circular`
같은 집계 의미를 추가하는 것이 바람직합니다. 이 변경은 payload schema를 바꾸지
않아도 되지만 history 응답과 테스트는 변경됩니다.

## 7. 관측 및 집계 규칙

### 권장 전송 주기

- D1 전송 레코드: 수경재배 노드와 같은 약 2분 주기
- 온도·습도·기압: 전송 시점에 한 번 측정하거나 짧은 평균 사용
- 풍속: 로컬에서 1초 정도로 자주 표본화하고 2분 평균 생성
- 돌풍: 가능하면 3초 이동평균의 2분 내 최댓값
- 풍향: 벡터 평균을 권장하며 무풍·센서 불능은 `null`
- 전도식 강우계: tip interrupt는 계속 계수하고 2분 동안 증가한 양만 전송

고속 표본 전체를 D1에 올리지 않습니다. 바람과 강우의 고속 처리는 장치가 맡고,
서버에는 운영과 장기 비교에 필요한 요약을 보냅니다. 집계 방식이 바뀌면 펌웨어
버전과 릴리스 노트에 기록합니다.

두 노드를 2분 주기로 운용하는 것 자체는 작은 규모지만 metric 수만큼
`measurement_values` 행이 증가합니다. 새 센서를 추가할 때는 D1 읽기·쓰기 사용량,
일별 백업 크기와 대시보드 조회 범위를 함께 확인합니다. 이 때문에 풍속의 1초
원시 표본을 서버로 보내지 않고 장치에서 먼저 요약합니다.

### 시간 규칙

- 장치는 NTP 또는 검증된 RTC로 시각을 확보합니다.
- JSON은 `Z` 또는 명시적 offset이 있는 ISO 8601을 사용합니다.
- 저장은 UTC, 날짜 경계와 화면 표시는 `Asia/Tokyo`를 사용합니다.
- 시각이 유효하지 않으면 현재 시각을 추측해 전송하지 않습니다.
- 업로드 장애 후에도 원래 `measured_at`을 유지해 과거 공백을 채웁니다.

### 부분 결측과 품질

지원 quality는 현재 계약과 동일합니다.

| quality | 의미 |
| --- | --- |
| `valid` | 정상 측정 및 정상 범위 |
| `missing` | 읽기 실패·센서 미응답·값 없음 |
| `invalid` | 형식 또는 물리 범위 위반 |
| `stale` | 새 측정이 아닌 오래된 값 |
| `suspect` | 저장은 하지만 차폐·결로·포화 등으로 신뢰가 낮음 |
| `calibrating` | 예열·교정 중인 참고값 |

예를 들어 우량계가 실패해도 온도와 습도는 같은 레코드로 전송합니다. diagnostic은
`wind_vane_out_of_range`, `sensor_heating`, `rain_counter_reset`처럼 짧고 안정적인
코드를 사용하며 비밀정보나 긴 로그를 넣지 않습니다.

## 8. 장치 카탈로그와 교정 관리

기상대 활성화 전에 D1에 다음 순서로 등록합니다.

1. `zones`: `balcony-01`
2. `firmware_releases`: 기상대 펌웨어와 source revision
3. `devices`: `balcony-weather-01`
4. `sensors`: 센서의 metric, 모델, 연결 방식, 설치일
5. `sensor_calibrations`: offset, scale, 기준 장비와 교정일
6. `device_credentials`: 새 장치만의 credential digest

설치 기록에는 최소한 다음 정보를 남깁니다.

- 온습도계 차폐통 종류와 설치 높이
- 벽·바닥·실외기·창문으로부터의 거리
- 풍속계 높이와 난간에 의한 차폐 방향
- 우량계 수평 조정일과 tip당 강수량
- 센서 교체·청소·위치 변경 시각
- 펌웨어 버전과 집계 알고리즘 버전

위치 변경은 과거 데이터를 수정하지 않습니다. 큰 변경은 새 sensor 레코드 또는
설치 이벤트로 남겨 전후 데이터가 같은 조건인 것처럼 해석되지 않게 합니다.

정확한 주소·좌표·창문 방향 등 사생활 정보는 공개 API 응답이나 metric에 넣지
않습니다. 필요한 상세 설치 기록은 비공개 운영 문서 또는 Access 보호 화면에만
둡니다.

## 9. 인증과 보안

- 두 ESP32가 토큰을 공유하지 않습니다.
- 토큰 원문은 각 프로젝트의 Git 제외 `secrets.h`에만 둡니다.
- D1에는 lowercase SHA-256 digest만 저장합니다.
- 토큰 유출 시 해당 `device_credentials.revoked_at`만 설정해 즉시 폐기합니다.
- 교체 토큰은 새 credential 행으로 먼저 등록하고 장치 업데이트 확인 후 구 토큰을
  폐기합니다.
- 발코니 장치는 실내 장치보다 물리적 접근·도난 가능성이 높다고 가정합니다.
- 공개 history API는 정확한 위치, device credential, firmware/reset metadata를
  노출하지 않습니다.
- 관리자 export와 설정은 계속 Cloudflare Access로 보호합니다.

## 10. 로컬 보존과 재전송

기상대도 수경재배 노드와 같은 전달 보장 방식을 권장합니다.

- 측정 레코드를 먼저 LittleFS 링버퍼에 저장
- 실시간 전송은 별도 큐에서 수행
- 최대 15건씩 오래된 순서로 벌크 복구
- `accepted`/`duplicate` 응답 후에만 완료 표시
- 30초~30분 지수 백오프와 지터
- 한 레코드의 재시도가 신규 측정을 막지 않게 네트워크 작업 분리

보존 기간은 무조건 14일로 복사하지 말고 최종 레코드 크기와 LittleFS 파티션을
기준으로 다시 계산합니다. 목표는 최소 7일, 가능하면 14일입니다. 강우 tip 같은
짧은 이벤트도 전송 주기 레코드에 누적해 네트워크 장애 중 유실되지 않게 합니다.

## 11. 조회·대시보드·보고서

기존 history API는 이미 `site_id`, `zone_id`, `device_id`, `metrics` 필터를
지원합니다. 두 장치에 같은 `air_temperature`가 존재하므로 운영 코드에서는 가능한
한 device 또는 zone 필터를 명시합니다.

```text
/v1/readings/latest?device_id=esp32-01
/v1/readings/latest?device_id=balcony-weather-01
/v1/history/hourly?days=7&device_id=balcony-weather-01
/v1/history/hourly?days=7&site_id=home-lab&metrics=air_temperature,humidity
```

권장 화면 구조는 한 카드에 모든 값을 섞는 방식이 아닙니다.

- **재배환경 탭:** 현재 타워와 조명·수온·CO₂·PPFD
- **발코니 기상 탭:** 온습도·기압·바람·강우와 장치 상태
- **환경 비교 탭:** 실내/발코니/JMA의 시간 정렬 비교

JMA는 공식 기준 관측, 발코니는 실제 주거지의 미기후 관측이라는 역할을 유지합니다.
서로 값이 다르다는 이유만으로 어느 한쪽을 자동 보정하지 않습니다.

일일 수경재배 보고서는 계속 `esp32-01`을 기본 실내 소스로 지정하고, 기상대가
안정화된 뒤에만 `balcony-weather-01`을 실외 비교 소스로 추가합니다. device 필터
없는 평균으로 실내외 값을 섞지 않습니다.

## 12. 경고 정책

기상대에는 타워용 고온·VPD·수온 임계값을 그대로 적용하지 않습니다. 규칙은
device/zone 범위를 명확히 구분합니다.

초기 권장 경고:

- 기상대 전체 데이터 단절
- 핵심 센서 연속 결측
- 배터리 또는 공급전압 저하(해당 하드웨어가 있을 때)
- 강우계·풍속계의 장시간 고정값은 충분한 검증 후 도입

강풍·폭우 경고는 센서 설치와 교정이 안정된 뒤 추가합니다. 초기에는 거짓 경보를
줄이기 위해 Discord 통지 없이 대시보드 진단만 기록하는 shadow 기간을 둡니다.
경고 메시지에는 반드시 `발코니 기상대` 또는 `balcony-01`을 표시해 타워 경고와
혼동하지 않게 합니다.

## 13. 백업과 보존

동일 D1의 공통 `readings`와 `measurement_values`를 사용하면 전체 D1 SQL 백업은
새 장치 데이터도 자동으로 포함합니다. 다만 운영 전 다음 항목을 검증합니다.

- portable sensor JSON에 두 device가 모두 포함되는지
- manifest row count가 장치 추가 후에도 일치하는지
- 복구 훈련에서 device·sensor 외래키가 유지되는지
- 일별 강수 합계가 지연 백필 후에도 중복되지 않는지

R2 보존 정책은 기존 일일·주간 백업 정책을 공유합니다. 기상대 전용 버킷은 데이터
양이나 보존 요구가 실제로 달라질 때만 분리합니다.

## 14. 운영 점검 주기

### 매일 자동 점검

- 장치별 마지막 수신 시각
- 기대 주기 대비 데이터 공백
- metric별 valid/missing 비율
- LittleFS 백필이 정상적으로 duplicate/accepted 처리되는지

### 월별 또는 기상 변화 후 수동 점검

- 차폐통 오염·직사광 영향·결로
- 풍속계 회전과 풍향계 영점
- 우량계 수평·배수·이물질
- 케이블 방수, 부식과 커넥터 장력
- 전원 전압과 Wi-Fi RSSI 추세
- JMA와의 변화 방향 비교 및 비정상적인 장기 편차

### 센서·설치 변경 시

- 변경 전후 사진과 설치 조건 기록
- sensor/calibration/firmware catalog 갱신
- 최소 24시간 shadow 관측
- 대시보드·경고 활성화는 데이터 품질 확인 후 수행

## 15. 장애 대응

| 상황 | 기대 동작 | 운영 조치 |
| --- | --- | --- |
| Wi-Fi/Worker 장애 | 로컬 링에 계속 기록 | 복구 후 oldest-first 백필 확인 |
| D1 중복 응답 | 새 행을 만들지 않음 | `duplicate`면 로컬 완료 처리 |
| 센서 하나 실패 | 다른 metric은 저장·전송 | quality와 diagnostic 확인 |
| NTP 실패 | 잘못된 시각 전송 금지 | 시각 회복 후 정상 기록 재개 |
| 장치 토큰 유출 | 해당 장치만 위험 | credential 폐기·교체, 타워 토큰 유지 |
| 기상대 전원 상실 | 타워 운영은 지속 | 발코니 node만 복구 |
| 이상값 급증 | invalid/suspect로 격리 | 설치·배선·물리 상태 확인 후 교정 |

## 16. 단계별 도입 계획

### 1단계: 계약 확정

- 실제 기상대 센서와 측정 방식을 확정
- 신규 metric 이름·단위·범위·집계법 검토
- Worker allowlist와 테스트를 먼저 추가
- 강수 합계·돌풍 최댓값·풍향 원형 평균의 history 집계 경로 추가

### 2단계: 장치 등록

- `balcony-01`, `balcony-weather-01`, sensor catalog 등록
- 장치 전용 credential 생성
- 운영 토큰은 기상대 저장소의 ignored secrets 파일에만 저장

### 3단계: shadow 수집

- 기상대 LittleFS·단건·벌크 재전송 구현
- D1에는 저장하지만 공개 대시보드와 Discord 경고에는 아직 사용하지 않음
- 최소 7일간 공백·결측·중복·재부팅·강우 누계를 검증

### 4단계: 화면 통합

- 발코니 탭과 장치 상태 추가
- 실내/발코니/JMA 비교 화면 추가
- 기존 재배 화면의 기본 device 필터가 `esp32-01`인지 회귀 테스트

### 5단계: 운영 통합

- 기상대 단절·센서 결측 경고 활성화
- 일일 보고서의 외부 비교 소스를 발코니 우선, JMA 기준 검증으로 확장
- D1/R2 백업과 로컬 복구 훈련 수행

## 17. 운영 전 승인 기준

다음을 모두 통과한 뒤 정식 데이터 소스로 취급합니다.

- [ ] 장치별 credential이 분리되어 있다.
- [ ] 부분 결측 레코드가 정상 저장된다.
- [ ] 동일 레코드 재전송이 `duplicate`로 처리된다.
- [ ] 30분 이상 네트워크 차단 후 공백이 순서대로 복구된다.
- [ ] 재부팅 후 boot ID/sequence 충돌이 없다.
- [ ] 시각 동기화 실패 중 잘못된 timestamp가 생성되지 않는다.
- [ ] wind/rain 집계 정의가 펌웨어 문서와 일치한다.
- [ ] device 필터로 타워와 발코니 이력이 완전히 분리된다.
- [ ] JMA와 발코니 데이터의 출처가 화면에서 명확히 구분된다.
- [ ] 기상대 장애가 조명·공조 제어에 영향을 주지 않는다.
- [ ] 백업 manifest와 복구 훈련이 두 장치를 포함한다.
- [ ] 공개 응답에 정확한 위치와 인증·진단 정보가 노출되지 않는다.

## 18. 당장 하지 않을 것

- 기상대 준비 전에 수경재배 펌웨어를 공통 펌웨어로 합치지 않습니다.
- 모든 후보 metric을 미리 D1 allowlist에 추가하지 않습니다.
- JMA 값을 발코니 센서값처럼 저장하거나 자동 보정 기준으로 덮어쓰지 않습니다.
- 검증되지 않은 lux→일사량, 기압→해면기압 변환을 원시값으로 저장하지 않습니다.
- 첫날부터 강풍·폭우 자동 경고나 재배 제어를 연결하지 않습니다.
- 서로 다른 프로젝트의 장치 토큰, OTA 비밀번호 또는 Wi-Fi 비밀번호를 공유하지
  않습니다.

이 구조를 따르면 발코니 기상대는 독립적으로 개발·복구할 수 있으면서도, 운영이
안정된 시점에는 현재 D1·R2·대시보드·보고서 체계에 자연스럽게 합류할 수 있습니다.
