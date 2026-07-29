/*
  ESP32 + BME280 Hydroponics Environment Logger v8.0
  --------------------------------------------------
  Reliability-focused release based on v7.2.3.

  Main improvements
  - Current-value and history polling are fully independent in the browser.
  - Each fetch owns its AbortController; stale finally/catch handlers cannot
    overwrite the state of a newer request.
  - Only the newest successful history response may replace the graph.
  - The selected range changes only after a successful response.
  - Polling stops completely while the tab is hidden and resumes independently.
  - History responses use a RAM snapshot and 2 KB buffered HTTP chunks.
  - History/CSV transmission stops when the client disconnects.
  - Dynamic responses explicitly close the HTTP connection to avoid stale sockets.
  - Stored sensor records are validated again during boot/cache rebuild/CSV export.
  - LittleFS failures propagate correctly; an incomplete cache is never marked ready.
  - Automatic LittleFS formatting is disabled by default to protect existing data.
  - HTTP duration, disconnect, storage, cache and heap diagnostics are exposed by
    /api/current and printed to Serial when useful.

  Existing binary file formats and paths are unchanged, so v7.x data is retained.
*/

#include <Wire.h>
#include "../../include/secrets.h"
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <FS.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <ThingSpeak.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <mbedtls/md.h>
#include <mbedtls/base64.h>
#include <time.h>
#include <string.h>
#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

// ================= USER SETTINGS =================
// SwitchBot OpenAPI v1.1 credentials. Keep TOKEN and SECRET private.
const char* TZ_INFO = "JST-9";

constexpr int I2C_SDA_PIN = 18;
constexpr int I2C_SCL_PIN = 19;
constexpr uint32_t SAMPLE_INTERVAL_MS = 120000UL;
constexpr uint8_t MAX_UPLOAD_ATTEMPTS = 1;
constexpr uint32_t UPLOAD_RETRY_DELAY_MS = 0UL;
constexpr uint8_t MAX_CONSECUTIVE_SENSOR_FAILURES = 5;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000UL;
constexpr uint32_t NTP_RETRY_INTERVAL_MS = 300000UL;
constexpr uint32_t MDNS_RETRY_INTERVAL_MS = 30000UL;
constexpr uint8_t THINGSPEAK_QUEUE_LENGTH = 4;
constexpr uint32_t THINGSPEAK_TASK_STACK = 6144;
constexpr uint8_t SWITCHBOT_QUEUE_LENGTH = 1;
constexpr uint32_t SWITCHBOT_TASK_STACK = 8192;
constexpr uint32_t SWITCHBOT_HTTP_TIMEOUT_MS = 10000UL;

// Keep false for an existing installation. Setting true may erase LittleFS if
// mounting fails, so use it only once for a genuinely new/unformatted partition.
constexpr bool FORMAT_LITTLEFS_IF_MOUNT_FAILED = false;

// ================= 30-DAY RING BUFFER =================
constexpr uint32_t RECORDS_PER_DAY = 24UL * 60UL / 2UL;
constexpr uint32_t MAX_RECORDS = 30UL * RECORDS_PER_DAY;
constexpr const char* LOG_FILE_PATH = "/sensor_ring.bin";
constexpr const char* LIGHT_EVENT_FILE_PATH = "/light_events.bin";
constexpr uint32_t MAX_LIGHT_EVENTS = 1024UL;
constexpr uint32_t VALID_EPOCH_MIN = 1704067200UL;

enum RecordFlags : uint8_t {
  FLAG_SENSOR_VALID = 1 << 0,
  FLAG_CLOUD_OK     = 1 << 1
};

struct __attribute__((packed)) SensorRecord {
  uint32_t timestamp;
  float temperature;
  float humidity;
  float pressure;
  int8_t rssi;
  uint8_t flags;
  uint16_t reserved;
};
static_assert(sizeof(SensorRecord) == 20, "SensorRecord must remain 20 bytes");

struct __attribute__((packed)) LightEvent {
  uint32_t timestamp;
  uint8_t state;
  uint8_t reserved[3];
};
static_assert(sizeof(LightEvent) == 8, "LightEvent must remain 8 bytes");

struct RangeSettings {
  time_t start;
  time_t end;
  uint32_t bucketSeconds;
};

struct CacheBucket {
  uint32_t bucketStart;
  uint16_t count;
  uint16_t reserved;
  float sumT;
  float sumH;
  float sumP;
};

struct ThingSpeakJob {
  SensorRecord record;
  uint32_t slot;
  float uptimeHours;
};

struct SwitchBotJob {
  uint32_t sampleTimestamp;
};

// Arduino 자동 함수 원형 생성용 전방 선언
class HttpChunkWriter;

constexpr uint32_t DAY_BUCKET_SECONDS = 120UL;
constexpr uint32_t WEEK_BUCKET_SECONDS = 600UL;
constexpr uint32_t MONTH_BUCKET_SECONDS = 3600UL;
constexpr size_t DAY_CACHE_SIZE = 24UL * 3600UL / DAY_BUCKET_SECONDS;
constexpr size_t WEEK_CACHE_SIZE = 7UL * 24UL * 3600UL / WEEK_BUCKET_SECONDS;
constexpr size_t MONTH_CACHE_SIZE = 30UL * 24UL * 3600UL / MONTH_BUCKET_SECONDS;
constexpr size_t HISTORY_SNAPSHOT_SIZE = WEEK_CACHE_SIZE;
constexpr size_t REQUIRED_LOG_BYTES = static_cast<size_t>(MAX_RECORDS) * sizeof(SensorRecord);

CacheBucket dayCache[DAY_CACHE_SIZE]{};
CacheBucket weekCache[WEEK_CACHE_SIZE]{};
CacheBucket monthCache[MONTH_CACHE_SIZE]{};
CacheBucket historySnapshot[HISTORY_SNAPSHOT_SIZE]{};
LightEvent lightEventCache[MAX_LIGHT_EVENTS]{};
LightEvent lightEventSnapshot[MAX_LIGHT_EVENTS]{};

constexpr size_t HTTP_CHUNK_BUFFER_SIZE = 2048;
constexpr size_t CSV_BATCH_SIZE = 96;
char httpChunkBuffer[HTTP_CHUNK_BUFFER_SIZE + 1]{};
SensorRecord csvBatch[CSV_BATCH_SIZE]{};
String currentJson;

int32_t newestSlot = -1;
uint32_t validRecordCount = 0;
bool sensorRingWrapped = false;
uint32_t invalidStoredRecordCount = 0;

int32_t newestLightEventSlot = -1;
uint32_t validLightEventCount = 0;
bool lightRingWrapped = false;
uint32_t invalidStoredLightEventCount = 0;
uint32_t lightEventCacheCount = 0;

Adafruit_BME280 bme;
WiFiClient thingSpeakClient;
WebServer server(80);
QueueHandle_t thingSpeakQueue = nullptr;
QueueHandle_t switchBotQueue = nullptr;
SemaphoreHandle_t fsMutex = nullptr;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t thingSpeakTaskHandle = nullptr;
TaskHandle_t switchBotTaskHandle = nullptr;

uint8_t bmeAddress = 0;
bool filesystemMounted = false;
bool filesystemReady = false;
bool historyCacheReady = false;
bool timeReady = false;
bool otaReady = false;
bool mdnsReady = false;
bool previousWiFiConnected = false;

uint32_t lastSampleMs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastNtpRequestMs = 0;
uint32_t lastMdnsAttemptMs = 0;
bool ntpRequestActive = false;
uint32_t consecutiveUploadFailures = 0;
uint8_t consecutiveSensorFailures = 0;
uint32_t droppedUploadJobs = 0;
bool thingSpeakTaskRunning = false;
bool switchBotTaskRunning = false;

float latestTemperature = NAN;
float latestHumidity = NAN;
float latestPressure = NAN;
int latestRssi = 0;
int latestThingSpeakCode = 0;
time_t latestMeasurementTime = 0;

bool latestLightStateKnown = false;
bool latestLightOn = false;
float latestLightVoltage = NAN;
float latestLightPower = NAN;
float latestLightCurrentA = NAN;
uint32_t latestLightMinutesToday = 0;
time_t latestSwitchBotUpdateTime = 0;
int latestSwitchBotHttpCode = 0;
int latestSwitchBotStatusCode = 0;
uint32_t consecutiveSwitchBotFailures = 0;
bool storedLightStateKnown = false;
bool lastStoredLightOn = false;
bool pendingLightEvent = false;
uint32_t pendingLightEventTimestamp = 0;
bool pendingLightEventOn = false;
uint32_t lastPendingLightWriteAttemptMs = 0;
uint32_t lastPendingLightBusyLogMs = 0;
constexpr uint32_t PENDING_LIGHT_WRITE_RETRY_MS = 500UL;
constexpr uint32_t PENDING_LIGHT_BUSY_LOG_INTERVAL_MS = 10000UL;

// HTTP diagnostics. WebServer handlers run on the main loop, so these values do
// not need an additional mutex.
uint32_t rootRequestCount = 0;
uint32_t currentRequestCount = 0;
uint32_t historyRequestCount = 0;
uint32_t csvRequestCount = 0;
uint32_t historyClientAbortCount = 0;
uint32_t csvClientAbortCount = 0;
uint32_t lastRootDurationMs = 0;
uint32_t lastCurrentDurationMs = 0;
uint32_t lastHistoryDurationMs = 0;
uint32_t maxHistoryDurationMs = 0;
uint32_t lastCsvDurationMs = 0;
uint32_t minFreeHeapObserved = UINT32_MAX;

// ================= LOCAL DASHBOARD =================
const char DASHBOARD_HTML[] PROGMEM = R"HTML(
<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><title>Hydroponics Sensor 8.0</title>
<style>:root{color-scheme:light dark;--bg:#f4f6f8;--card:#fff;--text:#18212b;--muted:#647181;--border:#dce2e8;--accent:#2463eb}@media(prefers-color-scheme:dark){:root{--bg:#11161d;--card:#19212b;--text:#edf2f7;--muted:#a7b0bc;--border:#303b47;--accent:#78a6ff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1100px;margin:auto;padding:18px}h1{font-size:1.45rem;margin:0 0 5px}.sub{color:var(--muted);margin-bottom:16px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.card,.panel{background:var(--card);border:1px solid var(--border);border-radius:13px;box-shadow:0 2px 10px rgba(0,0,0,.04)}.card{padding:14px}.label{font-size:.82rem;color:var(--muted)}.value{font-size:1.6rem;font-weight:700;margin-top:4px}.unit{font-size:.85rem;font-weight:500;color:var(--muted)}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0}button,a.button{border:1px solid var(--border);background:var(--card);color:var(--text);padding:8px 12px;border-radius:9px;text-decoration:none;cursor:pointer;font:inherit}button.active{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.65;cursor:wait}#state{margin-left:auto;color:var(--muted);font-size:.85rem}.panel{padding:13px;margin-bottom:12px}.panel h2{font-size:1rem;margin:0 0 8px}canvas{display:block;width:100%;height:230px}footer{color:var(--muted);font-size:.8rem;padding:8px 1px 20px}@media(max-width:600px){canvas{height:190px}#state{width:100%;margin-left:0}}</style></head><body><main>
<h1>수경재배 환경 센서</h1><div class="sub" id="clock">불러오는 중…</div><section class="cards">
<div class="card"><div class="label">온도</div><div class="value"><span id="temp">--</span><span class="unit"> °C</span></div></div><div class="card"><div class="label">습도</div><div class="value"><span id="hum">--</span><span class="unit"> %</span></div></div><div class="card"><div class="label">기압</div><div class="value"><span id="pres">--</span><span class="unit"> hPa</span></div></div><div class="card"><div class="label">Wi-Fi</div><div class="value"><span id="rssi">--</span><span class="unit"> dBm</span></div></div><div class="card"><div class="label">가동시간</div><div class="value" id="uptime" style="font-size:1.2rem">--</div></div><div class="card"><div class="label">ThingSpeak</div><div class="value" id="cloud" style="font-size:1.2rem">--</div></div><div class="card"><div class="label">LED 조명</div><div class="value" id="lightState" style="font-size:1.2rem">--</div></div><div class="card"><div class="label">조명 소비전력</div><div class="value"><span id="lightPower">--</span><span class="unit"> W</span></div></div><div class="card"><div class="label">조명 전압</div><div class="value"><span id="lightVoltage">--</span><span class="unit"> V</span></div></div><div class="card"><div class="label">조명 전류</div><div class="value"><span id="lightCurrent">--</span><span class="unit"> A</span></div></div><div class="card"><div class="label">오늘 조명 가동</div><div class="value" id="lightRuntime" style="font-size:1.2rem">--</div></div><div class="card"><div class="label">SwitchBot</div><div class="value" id="switchbot" style="font-size:1.05rem">--</div></div></section>
<div class="toolbar"><button data-range="day" class="active">오늘 0–24시</button><button data-range="week">최근 7일</button><button data-range="month">최근 30일</button><a class="button" href="/download.csv">30일 CSV</a><span id="state">그래프 준비 중…</span></div><section class="panel"><h2>온도 (°C)</h2><canvas id="chartT"></canvas></section><section class="panel"><h2>습도 (%)</h2><canvas id="chartH"></canvas></section><section class="panel"><h2>기압 (hPa)</h2><canvas id="chartP"></canvas></section><footer>펌웨어 8.0 · 오늘 화면은 00:00–24:00 고정, 7일은 10분 평균, 30일은 1시간 평균입니다. 노란 배경은 LED 조명 ON 구간이며 측정 공백에서는 선이 끊깁니다.</footer>
</main><script>
let displayedRange="day",requestedRange="day",historyData={range:"day",start:0,end:1,bucketSeconds:120,points:[],lightIntervals:[]};let currentTimer=0,historyTimer=0,currentController=null,historyController=null,currentSeq=0,historySeq=0,resizeFrame=0;const CURRENT_REFRESH_MS=15000,HISTORY_REFRESH_MS=120000,CURRENT_TIMEOUT_MS=8000,HISTORY_TIMEOUT_MS=15000;const $=id=>document.getElementById(id),fmt=(v,n=1)=>Number.isFinite(v)?v.toFixed(n):"--";
function setActiveRange(r){document.querySelectorAll('button[data-range]').forEach(b=>b.classList.toggle('active',b.dataset.range===r))}function clearCurrentTimer(){clearTimeout(currentTimer);currentTimer=0}function clearHistoryTimer(){clearTimeout(historyTimer);historyTimer=0}function scheduleCurrent(d=CURRENT_REFRESH_MS){clearCurrentTimer();if(!document.hidden)currentTimer=setTimeout(runCurrentLoop,d)}function scheduleHistory(d=HISTORY_REFRESH_MS){clearHistoryTimer();if(!document.hidden)historyTimer=setTimeout(runHistoryLoop,d)}function cancelCurrent(){currentSeq++;const c=currentController;currentController=null;if(c)c.abort()}function cancelHistory(){historySeq++;const c=historyController;historyController=null;if(c)c.abort()}
async function refreshCurrent(){if(document.hidden)return false;const seq=++currentSeq,controller=new AbortController(),old=currentController;currentController=controller;if(old)old.abort();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort()},CURRENT_TIMEOUT_MS);try{const r=await fetch('/api/current',{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();if(seq!==currentSeq)return false;$('temp').textContent=fmt(d.temperature,2);$('hum').textContent=fmt(d.humidity,2);$('pres').textContent=fmt(d.pressure,2);$('rssi').textContent=d.rssi??'--';$('uptime').textContent=d.uptimeText||'--';$('cloud').textContent=d.cloudOk?'정상':(d.cloudCode===0?'대기':('오류 '+d.cloudCode));$('lightState').textContent=d.lightKnown?(d.lightOn?'ON':'OFF'):'--';$('lightPower').textContent=fmt(d.lightPower,1);$('lightVoltage').textContent=fmt(d.lightVoltage,1);$('lightCurrent').textContent=fmt(d.lightCurrent,3);$('lightRuntime').textContent=d.lightRuntimeText||'--';$('switchbot').textContent=d.switchBotOk?('정상 · '+(d.switchBotUpdateTime||'--')):(d.switchBotHttpCode===0?'대기':('오류 '+d.switchBotHttpCode));$('clock').textContent='마지막 측정: '+(d.measurementTime||'--')+' · 장치 시각: '+(d.deviceTime||'--');return true}catch(e){if(seq===currentSeq&&(e.name!=='AbortError'||timedOut))$('clock').textContent=timedOut?'현재 상태 요청 시간 초과':'현재 상태를 불러오지 못했습니다.';return false}finally{clearTimeout(timer);if(currentController===controller)currentController=null}}
function validHistory(d){return d&&Number.isFinite(d.start)&&Number.isFinite(d.end)&&d.end>d.start&&Number.isFinite(d.bucketSeconds)&&Array.isArray(d.points)&&Array.isArray(d.lightIntervals)}
async function loadHistory(range){if(document.hidden)return false;requestedRange=range;const seq=++historySeq,controller=new AbortController(),old=historyController;historyController=controller;if(old)old.abort();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort()},HISTORY_TIMEOUT_MS);$('state').textContent='데이터 불러오는 중…';try{const r=await fetch('/api/history?range='+encodeURIComponent(range),{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();if(seq!==historySeq)return false;if(!validHistory(d))throw new Error('Invalid history response');historyData=d;displayedRange=range;requestedRange=range;setActiveRange(displayedRange);$('state').textContent=d.points.length.toLocaleString()+'개 점';drawAll();return true}catch(e){if(seq===historySeq){if(e.name==='AbortError'){if(timedOut)$('state').textContent='그래프 요청 시간 초과'}else $('state').textContent='그래프 데이터 오류'}return false}finally{clearTimeout(timer);if(historyController===controller)historyController=null}}
async function runCurrentLoop(){currentTimer=0;if(document.hidden)return;await refreshCurrent();scheduleCurrent()}async function runHistoryLoop(){historyTimer=0;if(document.hidden)return;await loadHistory(displayedRange);scheduleHistory()}function startPolling(){if(document.hidden)return;refreshCurrent().finally(()=>scheduleCurrent());loadHistory(displayedRange).finally(()=>scheduleHistory())}
function niceBounds(v,t){let s,p,e;if(t==='temp'){s=10;p=2.5;e=[15,35]}else if(t==='hum'){s=20;p=5;e=[30,80]}else{s=40;p=10;e=[980,1040]}if(!v.length)return e;const a=Math.min(...v),b=Math.max(...v),r=b-a,q=r>0?r*.12:0,c=(a+b)/2,z=Math.max(r+q*2,s);let lo=Math.floor((c-z/2)/p)*p,hi=Math.ceil((c+z/2)/p)*p;if(hi-lo<s)hi=lo+s;return[lo,hi]}function xLabel(ts,start,range){if(range==='day')return Math.round((ts-start)/3600)+':00';const d=new Date(ts*1000);return(d.getMonth()+1)+'/'+d.getDate()}
function drawChart(id,index,type){const c=$(id),r=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.max(1,Math.round(r.width*dpr));c.height=Math.max(1,Math.round(r.height*dpr));const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);const w=r.width,h=r.height,css=getComputedStyle(document.documentElement),text=css.getPropertyValue('--muted').trim(),border=css.getPropertyValue('--border').trim(),accent=css.getPropertyValue('--accent').trim(),m={l:55,r:15,t:12,b:33},pw=w-m.l-m.r,ph=h-m.t-m.b,x0=historyData.start,x1=historyData.end;if(!(x1>x0)||pw<=0||ph<=0)return;x.clearRect(0,0,w,h);const pts=historyData.points.filter(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[index])),vals=pts.map(p=>p[index]),bounds=niceBounds(vals,type),y0=bounds[0],y1=bounds[1];x.fillStyle='rgba(255,193,7,0.18)';for(const iv of historyData.lightIntervals||[]){if(!Array.isArray(iv)||!Number.isFinite(iv[0])||!Number.isFinite(iv[1]))continue;const a=Math.max(x0,iv[0]),b=Math.min(x1,iv[1]);if(b<=a)continue;const l=m.l+(a-x0)/(x1-x0)*pw,u=m.l+(b-x0)/(x1-x0)*pw;x.fillRect(l,m.t,Math.max(1,u-l),ph)}x.font='12px system-ui';x.strokeStyle=border;x.fillStyle=text;x.lineWidth=1;for(let i=0;i<=4;i++){const y=m.t+ph*i/4;x.beginPath();x.moveTo(m.l,y);x.lineTo(w-m.r,y);x.stroke();x.textAlign='right';x.textBaseline='middle';x.fillText((y1-(y1-y0)*i/4).toFixed(1),m.l-7,y)}for(let i=0;i<=6;i++){const q=m.l+pw*i/6;x.beginPath();x.moveTo(q,m.t);x.lineTo(q,m.t+ph);x.stroke();x.textAlign=i===0?'left':(i===6?'right':'center');x.textBaseline='top';x.fillText(xLabel(x0+(x1-x0)*i/6,x0,displayedRange),q,m.t+ph+8)}if(pts.length){x.strokeStyle=accent;x.lineWidth=2;x.lineJoin='round';x.lineCap='round';x.beginPath();let started=false,prev=null;const gap=(historyData.bucketSeconds||120)*3;for(const p of pts){const q=m.l+(p[0]-x0)/(x1-x0)*pw,y=m.t+(y1-p[index])/(y1-y0)*ph;if(!started||prev===null||p[0]-prev>gap){x.moveTo(q,y);started=true}else x.lineTo(q,y);prev=p[0]}x.stroke()}else{x.fillStyle=text;x.textAlign='center';x.textBaseline='middle';x.fillText('표시할 데이터가 없습니다.',m.l+pw/2,m.t+ph/2)}}function drawAll(){drawChart('chartT',1,'temp');drawChart('chartH',2,'hum');drawChart('chartP',3,'pres')}
document.querySelectorAll('button[data-range]').forEach(b=>b.addEventListener('click',()=>{const range=b.dataset.range;clearHistoryTimer();loadHistory(range).finally(()=>scheduleHistory())}));window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(drawAll)});document.addEventListener('visibilitychange',()=>{if(document.hidden){clearCurrentTimer();clearHistoryTimer();cancelCurrent();cancelHistory()}else startPolling()});window.addEventListener('beforeunload',()=>{cancelCurrent();cancelHistory()});startPolling();
</script></body></html>
)HTML";

// ================= GENERIC HELPERS =================
bool takeMutex(SemaphoreHandle_t mutex, TickType_t waitTicks = portMAX_DELAY) {
  return mutex != nullptr && xSemaphoreTake(mutex, waitTicks) == pdTRUE;
}

void giveMutex(SemaphoreHandle_t mutex) {
  if (mutex != nullptr) xSemaphoreGive(mutex);
}

bool isTimeValid(time_t value) {
  return value >= static_cast<time_t>(VALID_EPOCH_MIN) &&
         static_cast<uint64_t>(value) <= UINT32_MAX;
}

bool formatLocalTimeToBuffer(time_t value, char* buffer, size_t bufferSize) {
  if (bufferSize == 0) return false;
  if (!isTimeValid(value)) {
    snprintf(buffer, bufferSize, "--");
    return false;
  }
  struct tm localTime{};
  localtime_r(&value, &localTime);
  strftime(buffer, bufferSize, "%Y-%m-%d %H:%M:%S", &localTime);
  return true;
}

String formatLocalTime(time_t value) {
  char buffer[32];
  formatLocalTimeToBuffer(value, buffer, sizeof(buffer));
  return String(buffer);
}

void formatUptimeToBuffer(char* buffer, size_t bufferSize) {
  uint64_t seconds = esp_timer_get_time() / 1000000ULL;
  uint32_t days = seconds / 86400ULL;
  uint8_t hours = (seconds % 86400ULL) / 3600ULL;
  uint8_t minutes = (seconds % 3600ULL) / 60ULL;
  if (days > 0) snprintf(buffer, bufferSize, "%u일 %u시간 %u분", days, hours, minutes);
  else snprintf(buffer, bufferSize, "%u시간 %u분", hours, minutes);
}

void formatLightRuntimeToBuffer(uint32_t minutes, char* buffer, size_t bufferSize) {
  snprintf(buffer, bufferSize, "%u시간 %u분", minutes / 60UL, minutes % 60UL);
}

bool validSensorData(float temperature, float humidity, float pressure) {
  return isfinite(temperature) && isfinite(humidity) && isfinite(pressure) &&
         temperature >= -40.0f && temperature <= 85.0f &&
         humidity >= 0.0f && humidity <= 100.0f &&
         pressure >= 300.0f && pressure <= 1100.0f;
}

bool validStoredRecord(const SensorRecord& record) {
  return record.timestamp >= VALID_EPOCH_MIN &&
         (record.flags & FLAG_SENSOR_VALID) != 0 &&
         validSensorData(record.temperature, record.humidity, record.pressure);
}

bool validStoredLightEvent(const LightEvent& event) {
  return event.timestamp >= VALID_EPOCH_MIN && event.state <= 1;
}

void updateMinFreeHeap() {
  uint32_t freeHeap = ESP.getFreeHeap();
  if (freeHeap < minFreeHeapObserved) minFreeHeapObserved = freeHeap;
}

bool httpClientConnected() {
  auto client = server.client();
  return client && client.connected();
}

void prepareDynamicResponse() {
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  server.sendHeader("Pragma", "no-cache");
  server.sendHeader("Connection", "close");
  auto client = server.client();
  if (client) client.setNoDelay(true);
}

class HttpChunkWriter {
 public:
  HttpChunkWriter() : length_(0), aborted_(false) {}

  bool append(const char* text) {
    return append(text, strlen(text));
  }

  bool append(const char* data, size_t dataLength) {
    if (aborted_) return false;
    while (dataLength > 0) {
      size_t available = HTTP_CHUNK_BUFFER_SIZE - length_;
      if (available == 0 && !flush()) return false;
      available = HTTP_CHUNK_BUFFER_SIZE - length_;
      size_t copyLength = dataLength < available ? dataLength : available;
      memcpy(httpChunkBuffer + length_, data, copyLength);
      length_ += copyLength;
      data += copyLength;
      dataLength -= copyLength;
      if (length_ == HTTP_CHUNK_BUFFER_SIZE && !flush()) return false;
    }
    return true;
  }

  bool flush() {
    if (aborted_) return false;
    if (length_ == 0) return true;
    if (!httpClientConnected()) {
      aborted_ = true;
      length_ = 0;
      return false;
    }
    server.sendContent(httpChunkBuffer, length_);
    length_ = 0;
    yield();
    if (!httpClientConnected()) {
      aborted_ = true;
      return false;
    }
    return true;
  }

  bool finish() {
    if (!flush()) return false;
    if (!httpClientConnected()) {
      aborted_ = true;
      return false;
    }
    server.sendContent("");
    return true;
  }

  bool aborted() const { return aborted_; }

 private:
  size_t length_;
  bool aborted_;
};

void serviceNetwork() {
  if (otaReady) ArduinoOTA.handle();
  server.handleClient();
  delay(1);
}

void servicedDelay(uint32_t milliseconds) {
  uint32_t started = millis();
  while (millis() - started < milliseconds) {
    serviceNetwork();
    delay(5);
  }
}

// ================= WI-FI / TIME / OTA =================
bool connectWiFi(uint32_t timeoutMs = 20000UL) {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.printf("Wi-Fi connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) {
    Serial.print('.');
    delay(500);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWi-Fi connection timed out.");
    previousWiFiConnected = false;
    return false;
  }
  previousWiFiConnected = true;
  Serial.println("\nWi-Fi connected.");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  Serial.printf("RSSI: %d dBm\n", WiFi.RSSI());
  return true;
}

void maintainWiFi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected) {
    if (!previousWiFiConnected) {
      previousWiFiConnected = true;
      mdnsReady = false;
      Serial.println("Wi-Fi reconnected.");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
    }
    return;
  }

  if (previousWiFiConnected) {
    previousWiFiConnected = false;
    if (mdnsReady) MDNS.end();
    mdnsReady = false;
    Serial.println("Wi-Fi disconnected.");
  }

  if (millis() - lastWiFiAttemptMs < WIFI_RECONNECT_INTERVAL_MS) return;
  lastWiFiAttemptMs = millis();
  Serial.println("Wi-Fi reconnecting.");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void requestTimeSync() {
  if (WiFi.status() != WL_CONNECTED) return;
  configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com", "time.nist.gov");
  lastNtpRequestMs = millis();
  ntpRequestActive = true;
  Serial.println("NTP synchronization requested (non-blocking).");
}

void maintainTimeSync() {
  time_t now = 0;
  time(&now);
  if (isTimeValid(now)) {
    if (!timeReady) Serial.printf("Time synchronized: %s\n", formatLocalTime(now).c_str());
    timeReady = true;
    ntpRequestActive = false;
    return;
  }
  timeReady = false;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!ntpRequestActive || millis() - lastNtpRequestMs >= NTP_RETRY_INTERVAL_MS) requestTimeSync();
}

void setupOTA() {
  if (otaReady) return;
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { Serial.println("OTA start"); });
  ArduinoOTA.onEnd([]() { Serial.println("\nOTA completed."); });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    unsigned int percent = total > 0 ? static_cast<unsigned int>((uint64_t)progress * 100ULL / total) : 0;
    Serial.printf("OTA progress: %u%%\r", percent);
  });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA error[%u]\n", error); });
  ArduinoOTA.begin();
  otaReady = true;
  Serial.printf("OTA ready: %s.local\n", OTA_HOSTNAME);
}

void setupMDNS() {
  if (mdnsReady || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastMdnsAttemptMs < MDNS_RETRY_INTERVAL_MS && lastMdnsAttemptMs != 0) return;
  lastMdnsAttemptMs = millis();
  MDNS.end();
  if (MDNS.begin(OTA_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    mdnsReady = true;
    Serial.printf("mDNS ready: http://%s.local/\n", OTA_HOSTNAME);
  } else {
    Serial.println("mDNS start failed; use the numeric IP address.");
  }
}

// ================= BME280 =================
bool initializeBME280() {
  if (bme.begin(0x76)) bmeAddress = 0x76;
  else if (bme.begin(0x77)) bmeAddress = 0x77;
  else {
    bmeAddress = 0;
    Serial.println("BME280 not found.");
    return false;
  }
  bme.setSampling(Adafruit_BME280::MODE_FORCED,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::FILTER_X4,
                  Adafruit_BME280::STANDBY_MS_0_5);
  Serial.printf("BME280 ready at 0x%02X\n", bmeAddress);
  return true;
}

bool readBME280(float& temperature, float& humidity, float& pressure) {
  if (bmeAddress == 0 && !initializeBME280()) return false;
  if (!bme.takeForcedMeasurement()) return false;
  temperature = bme.readTemperature();
  humidity = bme.readHumidity();
  pressure = bme.readPressure() / 100.0f;
  return validSensorData(temperature, humidity, pressure);
}

// ================= LITTLEFS LOW-LEVEL I/O =================
bool readRecordAt(File& file, uint32_t slot, SensorRecord& record) {
  size_t offset = static_cast<size_t>(slot) * sizeof(SensorRecord);
  if (!file.seek(offset, SeekSet)) return false;
  return file.read(reinterpret_cast<uint8_t*>(&record), sizeof(record)) == sizeof(record);
}

bool writeRecordAt(File& file, uint32_t slot, const SensorRecord& record) {
  size_t offset = static_cast<size_t>(slot) * sizeof(SensorRecord);
  if (!file.seek(offset, SeekSet)) return false;
  return file.write(reinterpret_cast<const uint8_t*>(&record), sizeof(record)) == sizeof(record);
}

bool readLightEventAt(File& file, uint32_t slot, LightEvent& event) {
  size_t offset = static_cast<size_t>(slot) * sizeof(LightEvent);
  if (!file.seek(offset, SeekSet)) return false;
  return file.read(reinterpret_cast<uint8_t*>(&event), sizeof(event)) == sizeof(event);
}

bool writeLightEventAt(File& file, uint32_t slot, const LightEvent& event) {
  size_t offset = static_cast<size_t>(slot) * sizeof(LightEvent);
  if (!file.seek(offset, SeekSet)) return false;
  return file.write(reinterpret_cast<const uint8_t*>(&event), sizeof(event)) == sizeof(event);
}

bool ensureRingFile() {
  if (!filesystemMounted) return false;
  File file = LittleFS.open(LOG_FILE_PATH, "r");
  size_t currentSize = file ? file.size() : 0;
  if (file) file.close();
  if (currentSize == REQUIRED_LOG_BYTES) return true;

  Serial.printf("Creating ring file: %u bytes\n", static_cast<unsigned>(REQUIRED_LOG_BYTES));
  file = LittleFS.open(LOG_FILE_PATH, "w");
  if (!file) return false;
  if (!file.seek(REQUIRED_LOG_BYTES - 1, SeekSet)) {
    file.close();
    return false;
  }
  uint8_t zero = 0;
  bool ok = file.write(&zero, 1) == 1;
  file.flush();
  file.close();
  return ok;
}

bool ensureLightEventFile() {
  if (!filesystemMounted) return false;
  size_t requiredBytes = static_cast<size_t>(MAX_LIGHT_EVENTS) * sizeof(LightEvent);
  File file = LittleFS.open(LIGHT_EVENT_FILE_PATH, "r");
  size_t currentSize = file ? file.size() : 0;
  if (file) file.close();
  if (currentSize == requiredBytes) return true;

  Serial.printf("Creating light event file: %u bytes\n", static_cast<unsigned>(requiredBytes));
  file = LittleFS.open(LIGHT_EVENT_FILE_PATH, "w");
  if (!file) return false;
  if (!file.seek(requiredBytes - 1, SeekSet)) {
    file.close();
    return false;
  }
  uint8_t zero = 0;
  bool ok = file.write(&zero, 1) == 1;
  file.flush();
  file.close();
  return ok;
}

bool scanRingFile() {
  newestSlot = -1;
  validRecordCount = 0;
  invalidStoredRecordCount = 0;
  sensorRingWrapped = false;

  File file = LittleFS.open(LOG_FILE_PATH, "r");
  if (!file) return false;

  uint32_t newestTimestamp = 0;
  uint32_t highestValidSlot = 0;
  for (uint32_t slot = 0; slot < MAX_RECORDS; ++slot) {
    SensorRecord record{};
    if (!readRecordAt(file, slot, record)) {
      file.close();
      return false;
    }
    if (validStoredRecord(record)) {
      validRecordCount++;
      highestValidSlot = slot;
      if (record.timestamp >= newestTimestamp) {
        newestTimestamp = record.timestamp;
        newestSlot = static_cast<int32_t>(slot);
      }
    } else if (record.timestamp != 0 || record.flags != 0) {
      invalidStoredRecordCount++;
    }
    if ((slot & 0x3FFU) == 0) yield();
  }
  file.close();

  sensorRingWrapped = validRecordCount == MAX_RECORDS ||
                      (newestSlot >= 0 && highestValidSlot > static_cast<uint32_t>(newestSlot));
  Serial.printf("Ring scan: %u valid, %u invalid, newest slot %ld, wrapped=%s\n",
                validRecordCount, invalidStoredRecordCount, static_cast<long>(newestSlot),
                sensorRingWrapped ? "yes" : "no");
  return true;
}

uint32_t oldestSlot() {
  if (validRecordCount == 0 || newestSlot < 0) return 0;
  if (!sensorRingWrapped) return 0;
  return (static_cast<uint32_t>(newestSlot) + 1UL) % MAX_RECORDS;
}

bool scanLightEventFile() {
  newestLightEventSlot = -1;
  validLightEventCount = 0;
  invalidStoredLightEventCount = 0;
  lightEventCacheCount = 0;
  lightRingWrapped = false;
  storedLightStateKnown = false;

  File file = LittleFS.open(LIGHT_EVENT_FILE_PATH, "r");
  if (!file) return false;

  uint32_t newestTimestamp = 0;
  uint32_t highestValidSlot = 0;
  LightEvent newestEvent{};
  for (uint32_t slot = 0; slot < MAX_LIGHT_EVENTS; ++slot) {
    LightEvent event{};
    if (!readLightEventAt(file, slot, event)) {
      file.close();
      return false;
    }
    if (validStoredLightEvent(event)) {
      validLightEventCount++;
      highestValidSlot = slot;
      if (event.timestamp >= newestTimestamp) {
        newestTimestamp = event.timestamp;
        newestLightEventSlot = static_cast<int32_t>(slot);
        newestEvent = event;
      }
    } else if (event.timestamp != 0) {
      invalidStoredLightEventCount++;
    }
  }

  lightRingWrapped = validLightEventCount == MAX_LIGHT_EVENTS ||
                     (newestLightEventSlot >= 0 && highestValidSlot > static_cast<uint32_t>(newestLightEventSlot));

  if (validLightEventCount > 0 && newestLightEventSlot >= 0) {
    uint32_t startSlot = lightRingWrapped
      ? (static_cast<uint32_t>(newestLightEventSlot) + 1UL) % MAX_LIGHT_EVENTS
      : 0;
    uint32_t seen = 0;
    for (uint32_t offset = 0; offset < MAX_LIGHT_EVENTS && seen < validLightEventCount; ++offset) {
      uint32_t slot = (startSlot + offset) % MAX_LIGHT_EVENTS;
      LightEvent event{};
      if (!readLightEventAt(file, slot, event)) {
        file.close();
        return false;
      }
      if (!validStoredLightEvent(event)) continue;
      lightEventCache[lightEventCacheCount++] = event;
      seen++;
    }
    if (seen != validLightEventCount) {
      file.close();
      return false;
    }
  }
  file.close();

  if (newestLightEventSlot >= 0) {
    storedLightStateKnown = true;
    lastStoredLightOn = newestEvent.state == 1;
    latestLightStateKnown = true;
    latestLightOn = lastStoredLightOn;
  }

  Serial.printf("Light event scan: %u valid, %u invalid, newest slot %ld, RAM %u bytes\n",
                validLightEventCount, invalidStoredLightEventCount,
                static_cast<long>(newestLightEventSlot),
                static_cast<unsigned>(lightEventCacheCount * sizeof(LightEvent)));
  return true;
}

bool initializeFilesystem() {
  filesystemMounted = false;
  filesystemReady = false;
  historyCacheReady = false;

  if (!LittleFS.begin(FORMAT_LITTLEFS_IF_MOUNT_FAILED)) {
    Serial.println("LittleFS mount failed. Existing data was not auto-formatted.");
    return false;
  }
  filesystemMounted = true;

  Serial.printf("Flash: %u bytes\n", ESP.getFlashChipSize());
  Serial.printf("LittleFS total: %u bytes\n", LittleFS.totalBytes());
  Serial.printf("LittleFS used: %u bytes\n", LittleFS.usedBytes());
  Serial.printf("Ring required: %u bytes\n", static_cast<unsigned>(REQUIRED_LOG_BYTES));

  constexpr size_t SAFETY_MARGIN = 64UL * 1024UL;
  size_t totalRequired = REQUIRED_LOG_BYTES +
                         static_cast<size_t>(MAX_LIGHT_EVENTS) * sizeof(LightEvent) +
                         SAFETY_MARGIN;
  if (LittleFS.totalBytes() < totalRequired) {
    Serial.println("ERROR: LittleFS partition is too small for the configured history.");
    return false;
  }

  if (!takeMutex(fsMutex, pdMS_TO_TICKS(2000))) {
    Serial.println("ERROR: Could not lock LittleFS during initialization.");
    return false;
  }
  bool ok = ensureRingFile() && scanRingFile() && ensureLightEventFile() && scanLightEventFile();
  giveMutex(fsMutex);

  filesystemReady = ok;
  if (!ok) Serial.println("ERROR: LittleFS files could not be initialized or scanned.");
  return ok;
}

bool appendRecord(const SensorRecord& record, uint32_t& writtenSlot) {
  writtenSlot = UINT32_MAX;
  if (!filesystemReady || !validStoredRecord(record)) return false;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(1000))) return false;

  uint32_t nextSlot = newestSlot < 0 ? 0 : (static_cast<uint32_t>(newestSlot) + 1UL) % MAX_RECORDS;
  File file = LittleFS.open(LOG_FILE_PATH, "r+");
  if (!file) {
    giveMutex(fsMutex);
    return false;
  }

  SensorRecord previous{};
  bool previousRead = readRecordAt(file, nextSlot, previous);
  bool previousValid = previousRead && validStoredRecord(previous);
  bool ok = previousRead && writeRecordAt(file, nextSlot, record);
  file.flush();
  file.close();

  if (ok) {
    if (newestSlot >= 0 && nextSlot == 0) sensorRingWrapped = true;
    newestSlot = static_cast<int32_t>(nextSlot);
    if (!previousValid && validRecordCount < MAX_RECORDS) validRecordCount++;
    writtenSlot = nextSlot;
  }
  giveMutex(fsMutex);
  return ok;
}

bool markRecordCloudOk(uint32_t slot, uint32_t expectedTimestamp) {
  if (!filesystemReady || slot >= MAX_RECORDS) return false;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(1000))) return false;

  File file = LittleFS.open(LOG_FILE_PATH, "r+");
  if (!file) {
    giveMutex(fsMutex);
    return false;
  }
  SensorRecord record{};
  bool ok = readRecordAt(file, slot, record);
  if (ok && validStoredRecord(record) && record.timestamp == expectedTimestamp) {
    record.flags |= FLAG_CLOUD_OK;
    ok = writeRecordAt(file, slot, record);
  } else {
    ok = false;
  }
  file.flush();
  file.close();
  giveMutex(fsMutex);
  return ok;
}

template <typename Callback>
bool forEachRecordChronological(Callback callback) {
  if (!filesystemReady) return false;
  if (validRecordCount == 0) return true;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(2000))) return false;

  File file = LittleFS.open(LOG_FILE_PATH, "r");
  if (!file) {
    giveMutex(fsMutex);
    return false;
  }

  uint32_t snapshotCount = validRecordCount;
  uint32_t startSlot = oldestSlot();
  uint32_t seen = 0;
  bool ok = true;
  for (uint32_t offset = 0; offset < MAX_RECORDS && seen < snapshotCount; ++offset) {
    uint32_t slot = (startSlot + offset) % MAX_RECORDS;
    SensorRecord record{};
    if (!readRecordAt(file, slot, record)) {
      ok = false;
      break;
    }
    if (validStoredRecord(record)) {
      seen++;
      if (!callback(record)) {
        ok = false;
        break;
      }
    }
    if ((offset & 0xFFU) == 0) yield();
  }
  file.close();
  giveMutex(fsMutex);
  return ok && seen == snapshotCount;
}

// ================= HISTORY CACHE =================
void clearCacheBucket(CacheBucket& bucket, uint32_t bucketStart) {
  bucket.bucketStart = bucketStart;
  bucket.count = 0;
  bucket.reserved = 0;
  bucket.sumT = 0;
  bucket.sumH = 0;
  bucket.sumP = 0;
}

template <size_t N>
void addToCache(CacheBucket (&cache)[N], uint32_t bucketSeconds, const SensorRecord& record) {
  uint32_t bucketStart = (record.timestamp / bucketSeconds) * bucketSeconds;
  size_t index = (bucketStart / bucketSeconds) % N;
  CacheBucket& bucket = cache[index];
  if (bucket.bucketStart != bucketStart) clearCacheBucket(bucket, bucketStart);
  if (bucket.count < UINT16_MAX) bucket.count++;
  bucket.sumT += record.temperature;
  bucket.sumH += record.humidity;
  bucket.sumP += record.pressure;
}

bool addRecordToCaches(const SensorRecord& record) {
  if (!validStoredRecord(record)) return false;
  if (!takeMutex(stateMutex, portMAX_DELAY)) return false;
  addToCache(dayCache, DAY_BUCKET_SECONDS, record);
  addToCache(weekCache, WEEK_BUCKET_SECONDS, record);
  addToCache(monthCache, MONTH_BUCKET_SECONDS, record);
  giveMutex(stateMutex);
  return true;
}

bool rebuildHistoryCaches() {
  if (!filesystemReady) {
    if (takeMutex(stateMutex, pdMS_TO_TICKS(250))) {
      historyCacheReady = false;
      giveMutex(stateMutex);
    }
    return false;
  }

  Serial.println("Building RAM history caches...");
  if (!takeMutex(stateMutex, pdMS_TO_TICKS(1000))) return false;
  memset(dayCache, 0, sizeof(dayCache));
  memset(weekCache, 0, sizeof(weekCache));
  memset(monthCache, 0, sizeof(monthCache));
  historyCacheReady = false;
  giveMutex(stateMutex);

  // This is called during setup before network worker tasks start, so direct cache
  // writes avoid taking the state mutex tens of thousands of times.
  bool ok = forEachRecordChronological([](const SensorRecord& record) {
    if (!validStoredRecord(record)) return true;
    addToCache(dayCache, DAY_BUCKET_SECONDS, record);
    addToCache(weekCache, WEEK_BUCKET_SECONDS, record);
    addToCache(monthCache, MONTH_BUCKET_SECONDS, record);
    return true;
  });

  if (!takeMutex(stateMutex, pdMS_TO_TICKS(1000))) return false;
  historyCacheReady = ok;
  giveMutex(stateMutex);

  if (ok) {
    Serial.printf("History cache ready: day=%u, week=%u, month=%u buckets\n",
                  static_cast<unsigned>(DAY_CACHE_SIZE),
                  static_cast<unsigned>(WEEK_CACHE_SIZE),
                  static_cast<unsigned>(MONTH_CACHE_SIZE));
  } else {
    Serial.println("ERROR: History cache rebuild failed; /api/history will remain unavailable.");
  }
  return ok;
}

// ================= LIGHT EVENT STORAGE =================
uint32_t localMidnight(uint32_t timestamp) {
  time_t value = static_cast<time_t>(timestamp);
  struct tm local{};
  localtime_r(&value, &local);
  local.tm_hour = 0;
  local.tm_min = 0;
  local.tm_sec = 0;
  return static_cast<uint32_t>(mktime(&local));
}

bool appendLightEvent(uint32_t timestamp, bool on, TickType_t waitTicks) {
  if (!filesystemReady || timestamp < VALID_EPOCH_MIN) return false;

  // Preserve chronological order even if the system clock is corrected backwards.
  if (takeMutex(stateMutex, pdMS_TO_TICKS(100))) {
    if (lightEventCacheCount > 0) {
      uint32_t lastTimestamp = lightEventCache[lightEventCacheCount - 1].timestamp;
      if (timestamp <= lastTimestamp) {
        timestamp = lastTimestamp + 1UL;
        Serial.println("Light event timestamp adjusted to preserve chronological order.");
      }
    }
    giveMutex(stateMutex);
  }

  if (!takeMutex(fsMutex, waitTicks)) return false;
  uint32_t nextSlot = newestLightEventSlot < 0
    ? 0
    : (static_cast<uint32_t>(newestLightEventSlot) + 1UL) % MAX_LIGHT_EVENTS;
  File file = LittleFS.open(LIGHT_EVENT_FILE_PATH, "r+");
  if (!file) {
    giveMutex(fsMutex);
    return false;
  }

  LightEvent previous{};
  bool previousRead = readLightEventAt(file, nextSlot, previous);
  bool previousValid = previousRead && validStoredLightEvent(previous);
  LightEvent event{};
  event.timestamp = timestamp;
  event.state = on ? 1 : 0;
  bool ok = previousRead && writeLightEventAt(file, nextSlot, event);
  file.flush();
  file.close();
  giveMutex(fsMutex);
  if (!ok) return false;

  if (!takeMutex(stateMutex, portMAX_DELAY)) return false;
  if (newestLightEventSlot >= 0 && nextSlot == 0) lightRingWrapped = true;
  newestLightEventSlot = static_cast<int32_t>(nextSlot);
  if (!previousValid && validLightEventCount < MAX_LIGHT_EVENTS) validLightEventCount++;
  if (lightEventCacheCount < MAX_LIGHT_EVENTS) {
    lightEventCache[lightEventCacheCount++] = event;
  } else {
    memmove(&lightEventCache[0], &lightEventCache[1], (MAX_LIGHT_EVENTS - 1) * sizeof(LightEvent));
    lightEventCache[MAX_LIGHT_EVENTS - 1] = event;
  }
  giveMutex(stateMutex);

  Serial.printf("Light event: %s at %s (RAM cache: %u)\n",
                on ? "ON" : "OFF", formatLocalTime(timestamp).c_str(),
                static_cast<unsigned>(lightEventCacheCount));
  return true;
}

void scheduleObservedLightState(uint32_t sampleTimestamp, bool on, uint32_t minutesToday) {
  bool storedKnown = false;
  bool shouldSchedule = false;
  uint32_t eventCount = 0;

  if (!takeMutex(stateMutex, pdMS_TO_TICKS(250))) return;
  storedKnown = storedLightStateKnown;
  eventCount = validLightEventCount;
  shouldSchedule = (!storedLightStateKnown || lastStoredLightOn != on) &&
                   (!pendingLightEvent || pendingLightEventOn != on);
  giveMutex(stateMutex);
  if (!shouldSchedule) return;

  uint32_t eventTimestamp = sampleTimestamp;
  if (!storedKnown && eventCount == 0 && on && minutesToday > 0) {
    uint32_t midnight = localMidnight(sampleTimestamp);
    uint64_t runtimeSeconds = static_cast<uint64_t>(minutesToday) * 60ULL;
    uint64_t elapsedToday = sampleTimestamp >= midnight
      ? static_cast<uint64_t>(sampleTimestamp - midnight)
      : 0ULL;
    if (runtimeSeconds > elapsedToday) runtimeSeconds = elapsedToday;
    eventTimestamp = sampleTimestamp - static_cast<uint32_t>(runtimeSeconds);
    if (eventTimestamp < midnight) eventTimestamp = midnight;
    Serial.printf("Initial light ON inferred from daily runtime: %s (%u min).\n",
                  formatLocalTime(eventTimestamp).c_str(), static_cast<unsigned>(minutesToday));
  }

  if (!takeMutex(stateMutex, pdMS_TO_TICKS(250))) return;
  if ((!storedLightStateKnown || lastStoredLightOn != on) &&
      (!pendingLightEvent || pendingLightEventOn != on)) {
    pendingLightEvent = true;
    pendingLightEventTimestamp = eventTimestamp;
    pendingLightEventOn = on;
    lastPendingLightWriteAttemptMs = 0;
    Serial.printf("Light event queued in RAM: %s at %s\n",
                  on ? "ON" : "OFF", formatLocalTime(eventTimestamp).c_str());
  }
  giveMutex(stateMutex);
}

void processPendingLightEventWrite() {
  if (!filesystemReady) return;
  uint32_t nowMs = millis();
  if (lastPendingLightWriteAttemptMs != 0 &&
      nowMs - lastPendingLightWriteAttemptMs < PENDING_LIGHT_WRITE_RETRY_MS) return;

  bool hasPending = false;
  bool on = false;
  uint32_t timestamp = 0;
  if (!takeMutex(stateMutex, pdMS_TO_TICKS(100))) return;
  hasPending = pendingLightEvent;
  timestamp = pendingLightEventTimestamp;
  on = pendingLightEventOn;
  giveMutex(stateMutex);
  if (!hasPending) return;

  lastPendingLightWriteAttemptMs = nowMs;
  if (!appendLightEvent(timestamp, on, 0)) {
    if (nowMs - lastPendingLightBusyLogMs >= PENDING_LIGHT_BUSY_LOG_INTERVAL_MS) {
      Serial.println("Light event pending: LittleFS busy; main loop will keep retrying.");
      lastPendingLightBusyLogMs = nowMs;
    }
    return;
  }

  if (!takeMutex(stateMutex, pdMS_TO_TICKS(250))) return;
  storedLightStateKnown = true;
  lastStoredLightOn = on;
  if (pendingLightEvent && pendingLightEventTimestamp == timestamp && pendingLightEventOn == on) {
    pendingLightEvent = false;
  }
  giveMutex(stateMutex);
}

// ================= THINGSPEAK TASK =================
int uploadToThingSpeak(const ThingSpeakJob& job) {
  if (WiFi.status() != WL_CONNECTED) return -1000;
  int code = -1;
  for (uint8_t attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; ++attempt) {
    ThingSpeak.setField(1, job.record.temperature);
    ThingSpeak.setField(2, job.record.humidity);
    ThingSpeak.setField(3, job.record.pressure);
    ThingSpeak.setField(4, static_cast<long>(job.record.rssi));
    ThingSpeak.setField(5, job.uptimeHours);
    ThingSpeak.setStatus("Sensor online");
    code = ThingSpeak.writeFields(THINGSPEAK_CHANNEL_ID, THINGSPEAK_WRITE_API_KEY);
    if (code == 200) {
      Serial.printf("ThingSpeak upload succeeded on attempt %u.\n", attempt);
      return code;
    }
    Serial.printf("ThingSpeak attempt %u failed: %d\n", attempt, code);
    if (attempt < MAX_UPLOAD_ATTEMPTS) vTaskDelay(pdMS_TO_TICKS(UPLOAD_RETRY_DELAY_MS));
  }
  return code;
}

void thingSpeakTask(void* parameter) {
  thingSpeakTaskRunning = true;
  ThingSpeakJob job{};
  for (;;) {
    if (xQueueReceive(thingSpeakQueue, &job, portMAX_DELAY) != pdTRUE) continue;
    int code = uploadToThingSpeak(job);
    bool cloudOk = code == 200;

    if (takeMutex(stateMutex, portMAX_DELAY)) {
      latestThingSpeakCode = code;
      if (cloudOk) consecutiveUploadFailures = 0;
      else if (consecutiveUploadFailures < UINT32_MAX) consecutiveUploadFailures++;
      giveMutex(stateMutex);
    }

    if (cloudOk && job.slot < MAX_RECORDS &&
        !markRecordCloudOk(job.slot, job.record.timestamp)) {
      Serial.println("Failed to update local cloud-success flag.");
    }
    if (!cloudOk) {
      Serial.printf("Cloud upload failed; local record retained. Consecutive failures: %lu\n",
                    static_cast<unsigned long>(consecutiveUploadFailures));
    }
  }
}

bool setupThingSpeakTask() {
  thingSpeakQueue = xQueueCreate(THINGSPEAK_QUEUE_LENGTH, sizeof(ThingSpeakJob));
  if (!thingSpeakQueue) {
    Serial.println("ERROR: ThingSpeak queue creation failed.");
    return false;
  }
  BaseType_t result = xTaskCreatePinnedToCore(
    thingSpeakTask, "ThingSpeak", THINGSPEAK_TASK_STACK,
    nullptr, 1, &thingSpeakTaskHandle, 0);
  if (result != pdPASS) {
    Serial.println("ERROR: ThingSpeak task creation failed.");
    vQueueDelete(thingSpeakQueue);
    thingSpeakQueue = nullptr;
    return false;
  }
  Serial.println("ThingSpeak task started.");
  return true;
}

bool queueThingSpeakUpload(const SensorRecord& record, uint32_t slot) {
  if (!thingSpeakQueue) return false;
  ThingSpeakJob job{};
  job.record = record;
  job.slot = slot;
  job.uptimeHours = static_cast<float>(esp_timer_get_time() / 1000000ULL) / 3600.0f;
  if (xQueueSend(thingSpeakQueue, &job, 0) == pdTRUE) return true;
  droppedUploadJobs++;
  Serial.printf("ThingSpeak queue full; dropped upload job. Total dropped: %lu\n",
                static_cast<unsigned long>(droppedUploadJobs));
  return false;
}

// ================= SWITCHBOT TASK =================
String makeSwitchBotNonce() {
  char buffer[33];
  for (int i = 0; i < 4; ++i) {
    snprintf(buffer + i * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
  }
  return String(buffer);
}

bool makeSwitchBotSignature(const String& timestampMs, const String& nonce, String& signature) {
  String source = String(SWITCHBOT_TOKEN) + timestampMs + nonce;
  unsigned char digest[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info) return false;
  if (mbedtls_md_hmac(info,
                      reinterpret_cast<const unsigned char*>(SWITCHBOT_SECRET),
                      strlen(SWITCHBOT_SECRET),
                      reinterpret_cast<const unsigned char*>(source.c_str()),
                      source.length(), digest) != 0) return false;
  unsigned char output[64];
  size_t outputLength = 0;
  if (mbedtls_base64_encode(output, sizeof(output), &outputLength,
                            digest, sizeof(digest)) != 0) return false;
  output[outputLength] = '\0';
  signature = String(reinterpret_cast<char*>(output));
  return true;
}

bool extractJsonString(const String& json, const char* key, String& value) {
  String token = String("\"") + key + "\"";
  int position = json.indexOf(token);
  if (position < 0) return false;
  position = json.indexOf(':', position + token.length());
  if (position < 0) return false;
  position = json.indexOf('"', position + 1);
  if (position < 0) return false;
  int end = json.indexOf('"', position + 1);
  if (end < 0) return false;
  value = json.substring(position + 1, end);
  return true;
}

bool extractJsonNumber(const String& json, const char* key, double& value) {
  String token = String("\"") + key + "\"";
  int position = json.indexOf(token);
  if (position < 0) return false;
  position = json.indexOf(':', position + token.length());
  if (position < 0) return false;
  position++;
  while (position < static_cast<int>(json.length()) &&
         (json[position] == ' ' || json[position] == '\t')) position++;
  int end = position;
  while (end < static_cast<int>(json.length()) &&
         (isDigit(json[end]) || json[end] == '-' || json[end] == '+' ||
          json[end] == '.' || json[end] == 'e' || json[end] == 'E')) end++;
  if (end == position) return false;
  value = json.substring(position, end).toDouble();
  return isfinite(value);
}

bool querySwitchBot(uint32_t sampleTimestamp) {
  if (WiFi.status() != WL_CONNECTED || sampleTimestamp < VALID_EPOCH_MIN) return false;

  uint64_t timestampMilliseconds = static_cast<uint64_t>(time(nullptr)) * 1000ULL;
  char timestampBuffer[24];
  snprintf(timestampBuffer, sizeof(timestampBuffer), "%llu",
           static_cast<unsigned long long>(timestampMilliseconds));
  String timestamp(timestampBuffer);
  String nonce = makeSwitchBotNonce();
  String signature;
  if (!makeSwitchBotSignature(timestamp, nonce, signature)) {
    Serial.println("SwitchBot signature creation failed.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String("https://api.switch-bot.com/v1.1/devices/") +
               SWITCHBOT_DEVICE_ID + "/status";
  if (!http.begin(client, url)) {
    Serial.println("SwitchBot HTTP begin failed.");
    return false;
  }
  http.setTimeout(SWITCHBOT_HTTP_TIMEOUT_MS);
  http.addHeader("Authorization", SWITCHBOT_TOKEN);
  http.addHeader("sign", signature);
  http.addHeader("t", timestamp);
  http.addHeader("nonce", nonce);
  http.addHeader("Content-Type", "application/json; charset=utf8");

  int httpCode = http.GET();
  String body = httpCode > 0 ? http.getString() : String();
  http.end();

  double apiStatus = 0;
  double voltage = 0;
  double power = 0;
  double currentMilliamps = 0;
  double minutesToday = 0;
  String powerState;
  bool parsed = httpCode == 200 &&
                extractJsonNumber(body, "statusCode", apiStatus) && apiStatus == 100 &&
                extractJsonString(body, "power", powerState) &&
                extractJsonNumber(body, "voltage", voltage) &&
                extractJsonNumber(body, "weight", power) &&
                extractJsonNumber(body, "electricCurrent", currentMilliamps) &&
                extractJsonNumber(body, "electricityOfDay", minutesToday);

  if (!parsed) {
    if (takeMutex(stateMutex, portMAX_DELAY)) {
      latestSwitchBotHttpCode = httpCode;
      latestSwitchBotStatusCode = static_cast<int>(apiStatus);
      if (consecutiveSwitchBotFailures < UINT32_MAX) consecutiveSwitchBotFailures++;
      giveMutex(stateMutex);
    }
    Serial.printf("SwitchBot query failed: HTTP %d, API %.0f\n", httpCode, apiStatus);
    return false;
  }

  bool on = powerState == "on";
  uint32_t runtimeMinutes = minutesToday >= 0 ? static_cast<uint32_t>(minutesToday) : 0;
  if (takeMutex(stateMutex, portMAX_DELAY)) {
    latestLightStateKnown = true;
    latestLightOn = on;
    latestLightVoltage = static_cast<float>(voltage);
    latestLightPower = static_cast<float>(power);
    latestLightCurrentA = static_cast<float>(currentMilliamps / 1000.0);
    latestLightMinutesToday = runtimeMinutes;
    latestSwitchBotUpdateTime = sampleTimestamp;
    latestSwitchBotHttpCode = httpCode;
    latestSwitchBotStatusCode = static_cast<int>(apiStatus);
    consecutiveSwitchBotFailures = 0;
    giveMutex(stateMutex);
  }

  scheduleObservedLightState(sampleTimestamp, on, runtimeMinutes);
  Serial.printf("SwitchBot: %s, %.1f W, %.1f V, %.3f A, %u min today\n",
                on ? "ON" : "OFF", power, voltage, currentMilliamps / 1000.0,
                static_cast<unsigned>(runtimeMinutes));
  return true;
}

void switchBotTask(void* parameter) {
  switchBotTaskRunning = true;
  SwitchBotJob job{};
  for (;;) {
    if (xQueueReceive(switchBotQueue, &job, portMAX_DELAY) == pdTRUE) {
      querySwitchBot(job.sampleTimestamp);
    }
  }
}

bool setupSwitchBotTask() {
  switchBotQueue = xQueueCreate(SWITCHBOT_QUEUE_LENGTH, sizeof(SwitchBotJob));
  if (!switchBotQueue) {
    Serial.println("ERROR: SwitchBot queue creation failed.");
    return false;
  }
  BaseType_t result = xTaskCreatePinnedToCore(
    switchBotTask, "SwitchBot", SWITCHBOT_TASK_STACK,
    nullptr, 1, &switchBotTaskHandle, 0);
  if (result != pdPASS) {
    Serial.println("ERROR: SwitchBot task creation failed.");
    vQueueDelete(switchBotQueue);
    switchBotQueue = nullptr;
    return false;
  }
  Serial.println("SwitchBot task started.");
  return true;
}

bool queueSwitchBotQuery(uint32_t sampleTimestamp) {
  if (!switchBotQueue || sampleTimestamp < VALID_EPOCH_MIN) return false;
  SwitchBotJob job{sampleTimestamp};
  if (xQueueSend(switchBotQueue, &job, 0) == pdTRUE) return true;
  Serial.println("SwitchBot query skipped: previous query still pending.");
  return false;
}

// ================= HISTORY RESPONSE =================
RangeSettings historyRange(const String& range, time_t now) {
  RangeSettings settings{};
  if (range == "day") {
    struct tm local{};
    localtime_r(&now, &local);
    local.tm_hour = 0;
    local.tm_min = 0;
    local.tm_sec = 0;
    settings.start = mktime(&local);
    local.tm_mday += 1;
    settings.end = mktime(&local);
    settings.bucketSeconds = DAY_BUCKET_SECONDS;
  } else if (range == "week") {
    settings.end = now;
    settings.start = now - 7L * 24L * 3600L;
    settings.bucketSeconds = WEEK_BUCKET_SECONDS;
  } else {
    settings.end = now;
    settings.start = now - 30L * 24L * 3600L;
    settings.bucketSeconds = MONTH_BUCKET_SECONDS;
  }
  return settings;
}

bool captureHistorySnapshot(const String& range, size_t& cacheSize, uint32_t& lightCount) {
  cacheSize = 0;
  lightCount = 0;
  if (!takeMutex(stateMutex, pdMS_TO_TICKS(500))) return false;
  if (!historyCacheReady) {
    giveMutex(stateMutex);
    return false;
  }

  if (range == "day") {
    cacheSize = DAY_CACHE_SIZE;
    memcpy(historySnapshot, dayCache, sizeof(dayCache));
  } else if (range == "week") {
    cacheSize = WEEK_CACHE_SIZE;
    memcpy(historySnapshot, weekCache, sizeof(weekCache));
  } else {
    cacheSize = MONTH_CACHE_SIZE;
    memcpy(historySnapshot, monthCache, sizeof(monthCache));
  }

  lightCount = lightEventCacheCount < MAX_LIGHT_EVENTS
    ? lightEventCacheCount
    : MAX_LIGHT_EVENTS;
  if (lightCount > 0) {
    memcpy(lightEventSnapshot, lightEventCache, lightCount * sizeof(LightEvent));
  }
  giveMutex(stateMutex);
  return true;
}

bool sendCacheJsonSnapshot(size_t cacheSize, const RangeSettings& settings,
                           HttpChunkWriter& writer) {
  bool first = true;
  uint32_t start = static_cast<uint32_t>(settings.start);
  uint32_t end = static_cast<uint32_t>(settings.end);
  uint32_t bucketSeconds = settings.bucketSeconds;
  uint32_t bucketStart = start - start % bucketSeconds;

  for (uint32_t timestamp = bucketStart; timestamp < end; timestamp += bucketSeconds) {
    size_t index = (timestamp / bucketSeconds) % cacheSize;
    const CacheBucket& bucket = historySnapshot[index];
    if (bucket.bucketStart != timestamp || bucket.count == 0) continue;

    float temperature = bucket.sumT / bucket.count;
    float humidity = bucket.sumH / bucket.count;
    float pressure = bucket.sumP / bucket.count;
    if (!validSensorData(temperature, humidity, pressure)) continue;

    uint32_t pointTimestamp = timestamp + bucketSeconds / 2UL;
    if (pointTimestamp < start || pointTimestamp >= end) continue;
    char line[120];
    int length = snprintf(line, sizeof(line), "%s[%u,%.3f,%.3f,%.3f]",
                          first ? "" : ",", pointTimestamp,
                          temperature, humidity, pressure);
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(line)) return false;
    if (!writer.append(line, static_cast<size_t>(length))) return false;
    first = false;
  }
  return true;
}

bool sendLightIntervalsJsonSnapshot(uint32_t eventCount, const RangeSettings& settings,
                                    HttpChunkWriter& writer) {
  if (eventCount == 0) return true;

  time_t now;
  time(&now);
  uint32_t visibleEnd = static_cast<uint32_t>(settings.end);
  if (isTimeValid(now) && static_cast<uint32_t>(now) < visibleEnd) {
    visibleEnd = static_cast<uint32_t>(now);
  }
  uint32_t rangeStart = static_cast<uint32_t>(settings.start);
  if (visibleEnd <= rangeStart) return true;

  bool first = true;
  bool stateKnown = false;
  bool stateOn = false;
  uint32_t onStart = 0;

  for (uint32_t index = 0; index < eventCount; ++index) {
    const LightEvent& event = lightEventSnapshot[index];
    if (!validStoredLightEvent(event)) continue;
    if (event.timestamp <= rangeStart) {
      stateKnown = true;
      stateOn = event.state == 1;
      if (stateOn) onStart = rangeStart;
      continue;
    }
    if (event.timestamp >= visibleEnd) break;

    if (!stateKnown) {
      stateKnown = true;
      stateOn = event.state == 1;
      if (stateOn) onStart = event.timestamp;
      continue;
    }

    bool nextOn = event.state == 1;
    if (stateOn && !nextOn) {
      char interval[64];
      int length = snprintf(interval, sizeof(interval), "%s[%u,%u]",
                            first ? "" : ",", onStart, event.timestamp);
      if (length <= 0 || static_cast<size_t>(length) >= sizeof(interval)) return false;
      if (!writer.append(interval, static_cast<size_t>(length))) return false;
      first = false;
    } else if (!stateOn && nextOn) {
      onStart = event.timestamp;
    }
    stateOn = nextOn;
  }

  if (stateKnown && stateOn && onStart < visibleEnd) {
    char interval[64];
    int length = snprintf(interval, sizeof(interval), "%s[%u,%u]",
                          first ? "" : ",", onStart, visibleEnd);
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(interval)) return false;
    if (!writer.append(interval, static_cast<size_t>(length))) return false;
  }
  return true;
}

// ================= WEB HANDLERS =================
void appendJsonFloat(String& json, float value, uint8_t decimals) {
  if (!isfinite(value)) {
    json += "null";
    return;
  }
  char buffer[32];
  snprintf(buffer, sizeof(buffer), "%.*f", decimals, static_cast<double>(value));
  json += buffer;
}

void handleRoot() {
  uint32_t started = millis();
  rootRequestCount++;
  prepareDynamicResponse();
  server.send_P(200, "text/html; charset=utf-8", DASHBOARD_HTML);
  lastRootDurationMs = millis() - started;
  updateMinFreeHeap();
}

void handleCurrent() {
  uint32_t started = millis();
  currentRequestCount++;

  float temperature, humidity, pressure, lightVoltage, lightPower, lightCurrent;
  int storedRssi, cloudCode, switchBotHttp, switchBotStatus;
  time_t measuredAt, switchBotUpdatedAt;
  uint32_t uploadFailureStreak, switchBotFailures, lightMinutes;
  bool lightKnown, lightOn, eventPending;

  if (!takeMutex(stateMutex, pdMS_TO_TICKS(500))) {
    prepareDynamicResponse();
    server.send(503, "application/json", "{\"error\":\"State busy\"}");
    return;
  }
  temperature = latestTemperature;
  humidity = latestHumidity;
  pressure = latestPressure;
  storedRssi = latestRssi;
  cloudCode = latestThingSpeakCode;
  measuredAt = latestMeasurementTime;
  uploadFailureStreak = consecutiveUploadFailures;
  lightKnown = latestLightStateKnown;
  lightOn = latestLightOn;
  lightVoltage = latestLightVoltage;
  lightPower = latestLightPower;
  lightCurrent = latestLightCurrentA;
  lightMinutes = latestLightMinutesToday;
  switchBotUpdatedAt = latestSwitchBotUpdateTime;
  switchBotHttp = latestSwitchBotHttpCode;
  switchBotStatus = latestSwitchBotStatusCode;
  switchBotFailures = consecutiveSwitchBotFailures;
  eventPending = pendingLightEvent;
  bool cacheReadySnapshot = historyCacheReady;
  uint32_t lightCacheCountSnapshot = lightEventCacheCount;
  giveMutex(stateMutex);

  time_t now;
  time(&now);
  char uptimeBuffer[40];
  char runtimeBuffer[32];
  char measurementBuffer[32];
  char deviceTimeBuffer[32];
  char switchBotTimeBuffer[32];
  formatUptimeToBuffer(uptimeBuffer, sizeof(uptimeBuffer));
  formatLightRuntimeToBuffer(lightMinutes, runtimeBuffer, sizeof(runtimeBuffer));
  formatLocalTimeToBuffer(measuredAt, measurementBuffer, sizeof(measurementBuffer));
  formatLocalTimeToBuffer(now, deviceTimeBuffer, sizeof(deviceTimeBuffer));
  formatLocalTimeToBuffer(switchBotUpdatedAt, switchBotTimeBuffer, sizeof(switchBotTimeBuffer));

  int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : storedRssi;
  currentJson.remove(0);
  currentJson += "{\"version\":\"8.0\",\"temperature\":";
  appendJsonFloat(currentJson, temperature, 2);
  currentJson += ",\"humidity\":";
  appendJsonFloat(currentJson, humidity, 2);
  currentJson += ",\"pressure\":";
  appendJsonFloat(currentJson, pressure, 2);
  currentJson += ",\"rssi\":";
  currentJson += rssi;
  currentJson += ",\"uptimeText\":\"";
  currentJson += uptimeBuffer;
  currentJson += "\",\"cloudOk\":";
  currentJson += (cloudCode == 200 ? "true" : "false");
  currentJson += ",\"cloudCode\":";
  currentJson += cloudCode;
  currentJson += ",\"measurementTime\":\"";
  currentJson += measurementBuffer;
  currentJson += "\",\"deviceTime\":\"";
  currentJson += deviceTimeBuffer;
  currentJson += "\",\"lightKnown\":";
  currentJson += (lightKnown ? "true" : "false");
  currentJson += ",\"lightOn\":";
  currentJson += (lightOn ? "true" : "false");
  currentJson += ",\"lightVoltage\":";
  appendJsonFloat(currentJson, lightVoltage, 1);
  currentJson += ",\"lightPower\":";
  appendJsonFloat(currentJson, lightPower, 1);
  currentJson += ",\"lightCurrent\":";
  appendJsonFloat(currentJson, lightCurrent, 3);
  currentJson += ",\"lightRuntimeText\":\"";
  currentJson += runtimeBuffer;
  currentJson += "\",\"switchBotOk\":";
  currentJson += (switchBotHttp == 200 && switchBotStatus == 100) ? "true" : "false";
  currentJson += ",\"switchBotHttpCode\":";
  currentJson += switchBotHttp;
  currentJson += ",\"switchBotStatusCode\":";
  currentJson += switchBotStatus;
  currentJson += ",\"switchBotUpdateTime\":\"";
  currentJson += switchBotTimeBuffer;
  currentJson += "\",\"switchBotFailures\":";
  currentJson += switchBotFailures;
  currentJson += ",\"records\":";
  currentJson += validRecordCount;
  currentJson += ",\"invalidRecords\":";
  currentJson += invalidStoredRecordCount;
  currentJson += ",\"lightEvents\":";
  currentJson += validLightEventCount;
  currentJson += ",\"invalidLightEvents\":";
  currentJson += invalidStoredLightEventCount;
  currentJson += ",\"lightEventCache\":";
  currentJson += lightCacheCountSnapshot;
  currentJson += ",\"lightEventPending\":";
  currentJson += (eventPending ? "true" : "false");
  currentJson += ",\"cloudFailureStreak\":";
  currentJson += uploadFailureStreak;
  currentJson += ",\"uploadQueue\":";
  currentJson += (thingSpeakQueue ? uxQueueMessagesWaiting(thingSpeakQueue) : 0);
  currentJson += ",\"droppedUploads\":";
  currentJson += droppedUploadJobs;
  currentJson += ",\"filesystemMounted\":";
  currentJson += (filesystemMounted ? "true" : "false");
  currentJson += ",\"filesystemReady\":";
  currentJson += (filesystemReady ? "true" : "false");
  currentJson += ",\"cacheReady\":";
  currentJson += (cacheReadySnapshot ? "true" : "false");
  currentJson += ",\"freeHeap\":";
  currentJson += ESP.getFreeHeap();
  currentJson += ",\"minFreeHeapObserved\":";
  currentJson += (minFreeHeapObserved == UINT32_MAX ? ESP.getFreeHeap() : minFreeHeapObserved);
  currentJson += ",\"httpRootMs\":";
  currentJson += lastRootDurationMs;
  currentJson += ",\"httpCurrentMs\":";
  currentJson += lastCurrentDurationMs;
  currentJson += ",\"httpHistoryMs\":";
  currentJson += lastHistoryDurationMs;
  currentJson += ",\"httpHistoryMaxMs\":";
  currentJson += maxHistoryDurationMs;
  currentJson += ",\"historyDisconnects\":";
  currentJson += historyClientAbortCount;
  currentJson += ",\"csvDisconnects\":";
  currentJson += csvClientAbortCount;
  currentJson += "}";

  prepareDynamicResponse();
  server.send(200, "application/json; charset=utf-8", currentJson);
  lastCurrentDurationMs = millis() - started;
  updateMinFreeHeap();
}

void handleHistory() {
  uint32_t started = millis();
  historyRequestCount++;

  time_t now;
  time(&now);
  if (!isTimeValid(now)) {
    prepareDynamicResponse();
    server.send(503, "application/json", "{\"error\":\"Time not synchronized\"}");
    lastHistoryDurationMs = millis() - started;
    return;
  }

  String range = server.hasArg("range") ? server.arg("range") : "day";
  if (range != "day" && range != "week" && range != "month") range = "day";
  RangeSettings settings = historyRange(range, now);
  size_t cacheSize = 0;
  uint32_t lightCount = 0;
  if (!captureHistorySnapshot(range, cacheSize, lightCount)) {
    prepareDynamicResponse();
    server.send(503, "application/json", "{\"error\":\"History cache unavailable\"}");
    lastHistoryDurationMs = millis() - started;
    return;
  }

  prepareDynamicResponse();
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json; charset=utf-8", "");
  HttpChunkWriter writer;
  char header[180];
  int headerLength = snprintf(header, sizeof(header),
    "{\"range\":\"%s\",\"start\":%u,\"end\":%u,\"bucketSeconds\":%u,\"points\":[",
    range.c_str(), static_cast<uint32_t>(settings.start),
    static_cast<uint32_t>(settings.end), settings.bucketSeconds);

  bool ok = headerLength > 0 && static_cast<size_t>(headerLength) < sizeof(header) &&
            writer.append(header, static_cast<size_t>(headerLength)) &&
            sendCacheJsonSnapshot(cacheSize, settings, writer) &&
            writer.append("],\"lightIntervals\":[") &&
            sendLightIntervalsJsonSnapshot(lightCount, settings, writer) &&
            writer.append("]}") && writer.finish();

  if (!ok || writer.aborted()) historyClientAbortCount++;
  lastHistoryDurationMs = millis() - started;
  if (lastHistoryDurationMs > maxHistoryDurationMs) maxHistoryDurationMs = lastHistoryDurationMs;
  updateMinFreeHeap();
  Serial.printf("HTTP history %s: %lu ms%s\n", range.c_str(),
                static_cast<unsigned long>(lastHistoryDurationMs),
                (!ok || writer.aborted()) ? " (client disconnected/stream stopped)" : "");
}

bool waitForFilesystemDuringCsv(uint32_t maximumWaitMs) {
  uint32_t started = millis();
  while (millis() - started < maximumWaitMs) {
    if (!httpClientConnected()) return false;
    if (takeMutex(fsMutex, pdMS_TO_TICKS(100))) return true;
    yield();
  }
  return false;
}

void handleCsvDownload() {
  uint32_t started = millis();
  csvRequestCount++;
  if (!filesystemReady) {
    prepareDynamicResponse();
    server.send(503, "text/plain", "LittleFS unavailable");
    return;
  }

  time_t now;
  time(&now);
  time_t cutoff = now - 30L * 24L * 3600L;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(1000))) {
    prepareDynamicResponse();
    server.send(503, "text/plain", "Storage busy");
    return;
  }
  uint32_t snapshotStart = oldestSlot();
  uint32_t snapshotCount = validRecordCount;
  giveMutex(fsMutex);

  prepareDynamicResponse();
  server.sendHeader("Content-Disposition", "attachment; filename=\"hydroponics_30days.csv\"");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/csv; charset=utf-8", "");
  HttpChunkWriter writer;
  bool ok = writer.append("timestamp_local,epoch,temperature_C,humidity_percent,pressure_hPa,rssi_dBm,cloud_ok\n");

  uint32_t physicalOffset = 0;
  uint32_t validSeen = 0;
  while (ok && physicalOffset < MAX_RECORDS && validSeen < snapshotCount) {
    if (!waitForFilesystemDuringCsv(5000)) {
      ok = false;
      break;
    }

    File file = LittleFS.open(LOG_FILE_PATH, "r");
    if (!file) {
      giveMutex(fsMutex);
      ok = false;
      break;
    }

    size_t batchCount = 0;
    bool readOk = true;
    while (physicalOffset < MAX_RECORDS && validSeen < snapshotCount &&
           batchCount < CSV_BATCH_SIZE) {
      uint32_t slot = (snapshotStart + physicalOffset) % MAX_RECORDS;
      physicalOffset++;
      SensorRecord record{};
      if (!readRecordAt(file, slot, record)) {
        readOk = false;
        break;
      }
      if (!validStoredRecord(record)) continue;
      validSeen++;
      csvBatch[batchCount++] = record;
    }
    file.close();
    giveMutex(fsMutex);
    if (!readOk) {
      ok = false;
      break;
    }

    for (size_t index = 0; index < batchCount && ok; ++index) {
      const SensorRecord& record = csvBatch[index];
      if (record.timestamp < static_cast<uint32_t>(cutoff)) continue;
      char localTimeBuffer[32];
      formatLocalTimeToBuffer(record.timestamp, localTimeBuffer, sizeof(localTimeBuffer));
      char line[160];
      int length = snprintf(line, sizeof(line), "%s,%u,%.3f,%.3f,%.3f,%d,%u\n",
                            localTimeBuffer, record.timestamp, record.temperature,
                            record.humidity, record.pressure, record.rssi,
                            (record.flags & FLAG_CLOUD_OK) ? 1 : 0);
      if (length <= 0 || static_cast<size_t>(length) >= sizeof(line)) {
        ok = false;
        break;
      }
      ok = writer.append(line, static_cast<size_t>(length));
    }
    yield();
  }

  if (ok && validSeen != snapshotCount) ok = false;
  if (ok) ok = writer.finish();
  if (!ok || writer.aborted()) csvClientAbortCount++;
  lastCsvDurationMs = millis() - started;
  updateMinFreeHeap();
  Serial.printf("HTTP CSV: %lu ms%s\n", static_cast<unsigned long>(lastCsvDurationMs),
                (!ok || writer.aborted()) ? " (client disconnected/stream stopped)" : "");
}

void handleFavicon() {
  prepareDynamicResponse();
  server.send(204, "text/plain", "");
}

void handleNotFound() {
  prepareDynamicResponse();
  server.send(404, "text/plain; charset=utf-8", "Not found");
}

void setupWebServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/current", HTTP_GET, handleCurrent);
  server.on("/api/history", HTTP_GET, handleHistory);
  server.on("/download.csv", HTTP_GET, handleCsvDownload);
  server.on("/favicon.ico", HTTP_GET, handleFavicon);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server started.");
}

// ================= MEASUREMENT =================
void performMeasurementCycle() {
  time_t now;
  time(&now);
  if (!isTimeValid(now)) maintainTimeSync();
  time(&now);

  float temperature = NAN;
  float humidity = NAN;
  float pressure = NAN;
  if (!readBME280(temperature, humidity, pressure)) {
    consecutiveSensorFailures++;
    bmeAddress = 0;
    Serial.printf("Invalid sensor read (%u/%u).\n",
                  consecutiveSensorFailures, MAX_CONSECUTIVE_SENSOR_FAILURES);
    if (consecutiveSensorFailures >= MAX_CONSECUTIVE_SENSOR_FAILURES) {
      servicedDelay(1000);
      ESP.restart();
    }
    return;
  }
  consecutiveSensorFailures = 0;

  int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  if (takeMutex(stateMutex, portMAX_DELAY)) {
    latestTemperature = temperature;
    latestHumidity = humidity;
    latestPressure = pressure;
    latestRssi = rssi;
    latestMeasurementTime = isTimeValid(now) ? now : 0;
    giveMutex(stateMutex);
  }

  Serial.println("--------------------------------");
  Serial.printf("Time: %s\n", formatLocalTime(now).c_str());
  Serial.printf("Temperature: %.2f C\nHumidity: %.2f %%\nPressure: %.2f hPa\nRSSI: %d dBm\n",
                temperature, humidity, pressure, rssi);

  SensorRecord record{};
  record.timestamp = static_cast<uint32_t>(now);
  record.temperature = temperature;
  record.humidity = humidity;
  record.pressure = pressure;
  record.rssi = static_cast<int8_t>(constrain(rssi, -127, 0));
  record.flags = FLAG_SENSOR_VALID;

  bool localSaved = false;
  uint32_t writtenSlot = UINT32_MAX;
  if (filesystemReady && isTimeValid(now)) {
    localSaved = appendRecord(record, writtenSlot);
    if (localSaved) {
      if (!addRecordToCaches(record)) Serial.println("RAM cache update failed after local save.");
    } else {
      Serial.println("Local record append failed.");
    }
  }

  if (isTimeValid(now)) queueSwitchBotQuery(static_cast<uint32_t>(now));
  if (!queueThingSpeakUpload(record, localSaved ? writtenSlot : UINT32_MAX)) {
    if (takeMutex(stateMutex, portMAX_DELAY)) {
      latestThingSpeakCode = -2000;
      if (consecutiveUploadFailures < UINT32_MAX) consecutiveUploadFailures++;
      giveMutex(stateMutex);
    }
  }
  updateMinFreeHeap();
}

// ================= SETUP / LOOP =================
void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\nESP32 hydroponics logger v8.0 starting.");

  fsMutex = xSemaphoreCreateMutex();
  stateMutex = xSemaphoreCreateMutex();
  if (!fsMutex || !stateMutex) {
    Serial.println("FATAL: mutex creation failed; execution stopped.");
    while (true) delay(1000);
  }

  currentJson.reserve(1900);
  minFreeHeapObserved = ESP.getFreeHeap();
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  initializeBME280();
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    requestTimeSync();
    setupOTA();
    setupMDNS();
  }

  thingSpeakClient.setTimeout(3000);
  ThingSpeak.begin(thingSpeakClient);

  initializeFilesystem();
  rebuildHistoryCaches();
  Serial.printf("RAM cache bytes: history=%u, light=%u, snapshots=%u, free heap before tasks=%u\n",
                static_cast<unsigned>(sizeof(dayCache) + sizeof(weekCache) + sizeof(monthCache)),
                static_cast<unsigned>(sizeof(lightEventCache)),
                static_cast<unsigned>(sizeof(historySnapshot) + sizeof(lightEventSnapshot) +
                                      sizeof(csvBatch) + sizeof(httpChunkBuffer)),
                ESP.getFreeHeap());

  setupThingSpeakTask();
  setupSwitchBotTask();
  setupWebServer();
  lastSampleMs = millis() - SAMPLE_INTERVAL_MS;
  Serial.println("Setup complete.");
}

void loop() {
  maintainWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainTimeSync();
    setupOTA();
    setupMDNS();
  }

  processPendingLightEventWrite();
  serviceNetwork();

  if (millis() - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = millis();
    performMeasurementCycle();
  }

  processPendingLightEventWrite();
  updateMinFreeHeap();
  delay(5);
}
