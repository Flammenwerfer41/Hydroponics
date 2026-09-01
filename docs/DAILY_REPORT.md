# 일일 수경재배 환경 보고서 데이터

일일 보고서는 아래의 공개 브리지 JSON을 기본 데이터 소스로 사용한다.

- 기본 URL: `https://flammenwerfer41.github.io/Hydroponics/report-data.json`
- 자동 보고서 URL: `https://flammenwerfer41.github.io/Hydroponics/report-data.json?date=YYYY-MM-DD`
  - `YYYY-MM-DD`에는 분석 대상인 전날의 JST 날짜를 넣는다.
  - 매일 고유한 URL을 사용해 웹 리더와 CDN이 전날 응답을 재사용하는 것을 방지한다.
- Pages 응답의 날짜가 맞지 않을 때만 저장소 원본을 한 번 확인한다:
  `https://raw.githubusercontent.com/Flammenwerfer41/Hydroponics/main/docs/report-data.json?date=YYYY-MM-DD`
- 저장소 원본도 최신이 아닐 때에만 기존 ThingSpeak 보조 조회로 넘어간다.
- 기준 시간대: `Asia/Tokyo`
- 분석 기간: 전날 달력 날짜와 전날을 포함한 최근 7일
- 예약 시각: 매일 JST 00:10 GitHub Actions
  - GitHub 예약 작업은 혼잡할 때 실제 시작이 늦어질 수 있으므로 오전 보고서보다 충분히 일찍 예약한다.
  - JSON의 `generated_at`과 `period.yesterday`가 실제 성공 여부의 기준이며 예약 시각 자체를 신뢰하지 않는다.

## 스키마 2의 센서와 파생값

`yesterday.feeds`에는 약 2분 간격으로 다음 값이 들어간다. 일부 센서가 실패해도
행 전체를 버리지 않으며 해당 필드만 JSON `null`로 남긴다.

| JSON 필드 | 의미 | 단위 |
|---|---|---|
| `temperature` | 실내 기온 | °C |
| `humidity` | 실내 상대습도 | % |
| `pressure` | 실내 기압 | hPa |
| `wifi_rssi` | ESP32 Wi-Fi RSSI | dBm |
| `water_temperature` | 양액 수온 | °C |
| `co2_concentration` | SCD40 CO₂ 농도 | ppm |
| `illuminance` | VEML7700 원시 조도 | lux |
| `estimated_ppfd` | 조도에서 환산한 추정 PPFD | µmol/m²/s |
| `light_status`, `light_power`, `light_uptime` | SwitchBot 조명 상태 | 상태·W·분 |

추정 PPFD의 계수, 버전, 적용일과 `estimated` 한정어는
`calibrations.estimated_ppfd`에 기록한다. 현재 계수는 `0.01732`이며 PAR 센서의
실측값이 아니다. 일별 요약의 `estimated_dli_mol_m2_day`도 같은 추정 PPFD를
6분 이하의 유효 관측 간격만 적분한 참고값이다.

`daily_summary`와 `hourly_summary`에는 CO₂, 원시 조도와 추정 PPFD의 유효 표본 수,
최소·최대·평균이 포함된다. 전날 원시값은 중앙값, 극값 시각과 임계값 지속시간을
보고서 작성 단계에서 다시 계산할 수 있도록 보존한다.

## 자동 보고서 해석 규칙

- CO₂는 최소·최대·평균·중앙값, 극값 시각과 **1,000/1,500/2,500 ppm 이상
  지속시간**을 제시한다. 급격한 변화는 재실·환기·공조의 영향을 함께 고려하고
  식물의 흡수만으로 원인을 단정하지 않는다.
- PPFD는 반드시 **추정 PPFD(ePPFD)**라고 표시하고 계수 버전을 함께 밝힌다.
  조명 ON 구간의 평균·최대 ePPFD, 일별 추정 DLI와 7일 변화를 분석한다.
- 센서 위치, 잎 높이와 광분포가 대표성을 제한하므로 ePPFD 또는 추정 DLI만으로
  광포화·광저해·성장률을 확진하지 않는다.
- CO₂와 조도는 이제 직접 측정되므로 기존의 “CO₂·PPFD는 측정되지 않는다”라는
  한계 문구를 사용하지 않는다. 실제 잎 온도, PAR 센서 PPFD, DO, 자동 pH·EC는
  여전히 미측정 항목이다.
- CO₂ 또는 조도 표본이 부족하면 다른 센서의 유효한 자료는 그대로 분석하되,
  빠진 항목과 유효 표본 수를 데이터 품질 절에 따로 적는다.

## CO₂ 알림과의 관계

운영 알림은 30분 동안 1,500 ppm 이상이면 주의, 15분 동안 2,500 ppm 이상이면
경보로 전환한다. 각각 1,200/2,000 ppm 아래로 내려간 뒤 15분이 지나야 단계가
복구된다. 센서값이 3회 연속 빠지면 측정 실패 주의, 10회면 경보가 된다.

이 임계값은 거주 공간의 지속적인 환기 필요를 알리기 위한 운영값이다. 일본
후생노동성의 건축물 환경위생 관리기준은 CO₂ 1,000 ppm 이하를 관리 기준으로
제시한다. 짧은 재실 변화로 알림이 반복되는 것을 줄이기 위해 이 시스템의 상태
진입값은 더 높게 두고 지속시간과 히스테리시스를 적용한다.

- [후생노동성 건축물 환경위생 관리기준](https://www.mhlw.go.jp/bunya/kenkou/seikatsu-eisei10/index.html)
