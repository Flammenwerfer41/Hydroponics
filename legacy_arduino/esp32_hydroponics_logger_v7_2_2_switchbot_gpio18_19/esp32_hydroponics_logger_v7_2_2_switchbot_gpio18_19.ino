/*
  ESP32 + BME280 Hydroponics Environment Logger v7.2.2
  ------------------------------------------------
  Features
  - BME280 measurement every 2 minutes
  - ThingSpeak upload: temperature, humidity, pressure, RSSI, uptime
  - NTP time synchronization (JST / UTC+9)
  - 30-day binary ring buffer in LittleFS
  - Local dashboard:
      http://<OTA_HOSTNAME>.local/
      or the IP address printed in Serial Monitor
  - Today / 7 days / 30 days charts
  - "Today" chart is always fixed from 00:00 to 24:00
  - CSV download
  - Arduino OTA wireless firmware upload
  - Wi-Fi reconnect and local-first fault tolerance
  - Cloud failure does not restart the device
  - History charts are served from RAM caches instead of rescanning LittleFS
  - ThingSpeak upload runs in a separate FreeRTOS task
  - HTTP history/CSV generation avoids recursive WebServer handling
  - Non-blocking NTP synchronization and retry
  - CSV download releases the LittleFS mutex between small read batches
  - Browser prevents overlapping history requests
  - 30-day cache uses 1-hour buckets to reduce RAM use
  - RSSI is shown only as a current value, not stored in history caches
  - SwitchBot Plug Mini (JP) status queried every 2 minutes in a separate task
  - Current light power/voltage/current/runtime shown on the dashboard
  - Light ON/OFF changes stored as compact LittleFS events
  - Light ON intervals shown as warm yellow chart background bands
  - Sensor lines break across missing-data gaps
  - SwitchBot task only schedules light events in RAM; the main loop writes them to LittleFS
  - Pending light event writes retry without blocking the network task
  - First ON event can be inferred from SwitchBot daily runtime
  - Light-event history is cached in RAM; dashboard history requests never read LittleFS
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
constexpr uint8_t THINGSPEAK_QUEUE_LENGTH = 4;
constexpr uint32_t THINGSPEAK_TASK_STACK = 6144;
constexpr uint8_t SWITCHBOT_QUEUE_LENGTH = 1;
constexpr uint32_t SWITCHBOT_TASK_STACK = 8192;
constexpr uint32_t SWITCHBOT_HTTP_TIMEOUT_MS = 10000UL;

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

typedef struct {
  time_t start;
  time_t end;
  uint32_t bucketSeconds;
} RangeSettings;

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

constexpr uint32_t DAY_BUCKET_SECONDS = 120UL;
constexpr uint32_t WEEK_BUCKET_SECONDS = 600UL;
constexpr uint32_t MONTH_BUCKET_SECONDS = 3600UL;
constexpr size_t DAY_CACHE_SIZE = 24UL * 3600UL / DAY_BUCKET_SECONDS;
constexpr size_t WEEK_CACHE_SIZE = 7UL * 24UL * 3600UL / WEEK_BUCKET_SECONDS;
constexpr size_t MONTH_CACHE_SIZE = 30UL * 24UL * 3600UL / MONTH_BUCKET_SECONDS;

CacheBucket dayCache[DAY_CACHE_SIZE]{};
CacheBucket weekCache[WEEK_CACHE_SIZE]{};
CacheBucket monthCache[MONTH_CACHE_SIZE]{};
bool historyCacheReady = false;

RangeSettings historyRange(const String& range, time_t now);

constexpr size_t REQUIRED_LOG_BYTES =
  static_cast<size_t>(MAX_RECORDS) * sizeof(SensorRecord);

int32_t newestSlot = -1;
uint32_t validRecordCount = 0;
int32_t newestLightEventSlot = -1;
uint32_t validLightEventCount = 0;
LightEvent lightEventCache[MAX_LIGHT_EVENTS]{};
uint32_t lightEventCacheCount = 0;

Adafruit_BME280 bme;
WiFiClient thingSpeakClient;
WebServer server(80);
QueueHandle_t thingSpeakQueue = nullptr;
SemaphoreHandle_t fsMutex = nullptr;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t thingSpeakTaskHandle = nullptr;
QueueHandle_t switchBotQueue = nullptr;
TaskHandle_t switchBotTaskHandle = nullptr;

uint8_t bmeAddress = 0;
bool filesystemReady = false;
bool timeReady = false;
bool otaReady = false;
bool mdnsReady = false;

uint32_t lastSampleMs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastNtpRequestMs = 0;
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

// ================= LOCAL DASHBOARD =================
const char DASHBOARD_HTML[] PROGMEM = R"HTML(
<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hydroponics Sensor</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f8;--card:#fff;--text:#18212b;--muted:#647181;--border:#dce2e8;--accent:#2463eb}
@media(prefers-color-scheme:dark){:root{--bg:#11161d;--card:#19212b;--text:#edf2f7;--muted:#a7b0bc;--border:#303b47;--accent:#78a6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1100px;margin:auto;padding:18px}h1{font-size:1.45rem;margin:0 0 5px}.sub{color:var(--muted);margin-bottom:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.card,.panel{background:var(--card);border:1px solid var(--border);border-radius:13px;box-shadow:0 2px 10px rgba(0,0,0,.04)}
.card{padding:14px}.label{font-size:.82rem;color:var(--muted)}.value{font-size:1.6rem;font-weight:700;margin-top:4px}.unit{font-size:.85rem;font-weight:500;color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0}button,a.button{border:1px solid var(--border);background:var(--card);color:var(--text);padding:8px 12px;border-radius:9px;text-decoration:none;cursor:pointer;font:inherit}
button.active{background:var(--accent);border-color:var(--accent);color:white}#state{margin-left:auto;color:var(--muted);font-size:.85rem}.panel{padding:13px;margin-bottom:12px}.panel h2{font-size:1rem;margin:0 0 8px}canvas{display:block;width:100%;height:230px}footer{color:var(--muted);font-size:.8rem;padding:8px 1px 20px}@media(max-width:600px){canvas{height:190px}#state{width:100%;margin-left:0}}
</style></head><body><main>
<h1>수경재배 환경 센서</h1><div class="sub" id="clock">불러오는 중…</div>
<section class="cards">
<div class="card"><div class="label">온도</div><div class="value"><span id="temp">--</span><span class="unit"> °C</span></div></div>
<div class="card"><div class="label">습도</div><div class="value"><span id="hum">--</span><span class="unit"> %</span></div></div>
<div class="card"><div class="label">기압</div><div class="value"><span id="pres">--</span><span class="unit"> hPa</span></div></div>
<div class="card"><div class="label">Wi-Fi</div><div class="value"><span id="rssi">--</span><span class="unit"> dBm</span></div></div>
<div class="card"><div class="label">가동시간</div><div class="value" id="uptime" style="font-size:1.2rem">--</div></div>
<div class="card"><div class="label">ThingSpeak</div><div class="value" id="cloud" style="font-size:1.2rem">--</div></div>
<div class="card"><div class="label">LED 조명</div><div class="value" id="lightState" style="font-size:1.2rem">--</div></div>
<div class="card"><div class="label">조명 소비전력</div><div class="value"><span id="lightPower">--</span><span class="unit"> W</span></div></div>
<div class="card"><div class="label">조명 전압</div><div class="value"><span id="lightVoltage">--</span><span class="unit"> V</span></div></div>
<div class="card"><div class="label">조명 전류</div><div class="value"><span id="lightCurrent">--</span><span class="unit"> A</span></div></div>
<div class="card"><div class="label">오늘 조명 가동</div><div class="value" id="lightRuntime" style="font-size:1.2rem">--</div></div>
<div class="card"><div class="label">SwitchBot</div><div class="value" id="switchbot" style="font-size:1.05rem">--</div></div>
</section>
<div class="toolbar"><button data-range="day" class="active">오늘 0–24시</button><button data-range="week">최근 7일</button><button data-range="month">최근 30일</button><a class="button" href="/download.csv">30일 CSV</a><span id="state">그래프 준비 중…</span></div>
<section class="panel"><h2>온도 (°C)</h2><canvas id="chartT"></canvas></section>
<section class="panel"><h2>습도 (%)</h2><canvas id="chartH"></canvas></section>
<section class="panel"><h2>기압 (hPa)</h2><canvas id="chartP"></canvas></section>
<footer>오늘 화면의 시간축은 항상 현지시간 00:00–24:00으로 고정됩니다. 7일은 10분 평균, 30일은 1시간 평균입니다. 노란 배경은 LED 조명 ON 구간이며, 장시간 측정 공백에서는 선이 끊깁니다.</footer>
</main><script>
let activeRange="day",historyData={start:0,end:1,bucketSeconds:120,points:[],lightIntervals:[]},historyLoading=false,pendingHistoryRange=null;const $=id=>document.getElementById(id);const fmt=(v,n=1)=>Number.isFinite(v)?v.toFixed(n):"--";
async function refreshCurrent(){try{const r=await fetch('/api/current',{cache:'no-store'}),d=await r.json();$('temp').textContent=fmt(d.temperature,2);$('hum').textContent=fmt(d.humidity,2);$('pres').textContent=fmt(d.pressure,2);$('rssi').textContent=d.rssi??'--';$('uptime').textContent=d.uptimeText||'--';$('cloud').textContent=d.cloudOk?'정상':(d.cloudCode===0?'대기':('오류 '+d.cloudCode));$('lightState').textContent=d.lightKnown?(d.lightOn?'ON':'OFF'):'--';$('lightPower').textContent=fmt(d.lightPower,1);$('lightVoltage').textContent=fmt(d.lightVoltage,1);$('lightCurrent').textContent=fmt(d.lightCurrent,3);$('lightRuntime').textContent=d.lightRuntimeText||'--';$('switchbot').textContent=d.switchBotOk?('정상 · '+(d.switchBotUpdateTime||'--')):(d.switchBotHttpCode===0?'대기':('오류 '+d.switchBotHttpCode));$('clock').textContent='마지막 측정: '+(d.measurementTime||'--')+' · 장치 시각: '+(d.deviceTime||'--')}catch(e){$('clock').textContent='현재 상태를 불러오지 못했습니다.'}}
async function loadHistory(range){if(historyLoading){pendingHistoryRange=range;return}historyLoading=true;activeRange=range;document.querySelectorAll('button[data-range]').forEach(b=>b.classList.toggle('active',b.dataset.range===range));$('state').textContent='데이터 불러오는 중…';try{const r=await fetch('/api/history?range='+range,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);historyData=await r.json();$('state').textContent=historyData.points.length.toLocaleString()+'개 점';drawAll()}catch(e){$('state').textContent='그래프 데이터 오류'}finally{historyLoading=false;if(pendingHistoryRange!==null){const next=pendingHistoryRange;pendingHistoryRange=null;loadHistory(next)}}}
function niceBounds(values,type){let minSpan,step,emptyBounds;if(type==='temp'){minSpan=10;step=2.5;emptyBounds=[15,35]}else if(type==='hum'){minSpan=20;step=5;emptyBounds=[30,80]}else{minSpan=40;step=10;emptyBounds=[980,1040]}if(!values.length)return emptyBounds;const rawLo=Math.min(...values),rawHi=Math.max(...values),rawSpan=rawHi-rawLo,padding=rawSpan>0?rawSpan*.12:0,center=(rawLo+rawHi)/2,span=Math.max(rawSpan+padding*2,minSpan);let lo=center-span/2,hi=center+span/2;lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;if(hi-lo<minSpan)hi=lo+minSpan;return[lo,hi]}
function xLabel(ts,start,end,range){if(range==='day'){const h=(ts-start)/3600;return Math.round(h)+':00'}const d=new Date(ts*1000);return(d.getMonth()+1)+'/'+d.getDate()}
function drawChart(canvasId,index,type){const canvas=$(canvasId),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height,css=getComputedStyle(document.documentElement),text=css.getPropertyValue('--muted').trim(),border=css.getPropertyValue('--border').trim(),accent=css.getPropertyValue('--accent').trim();ctx.clearRect(0,0,w,h);const m={l:55,r:15,t:12,b:33},pw=w-m.l-m.r,ph=h-m.t-m.b,pts=historyData.points.filter(p=>Number.isFinite(p[index])),vals=pts.map(p=>p[index]),[y0,y1]=niceBounds(vals,type),x0=historyData.start,x1=historyData.end;ctx.fillStyle='rgba(255,193,7,0.18)';for(const iv of (historyData.lightIntervals||[])){const a=Math.max(x0,iv[0]),b=Math.min(x1,iv[1]);if(b<=a)continue;const lx1=m.l+(a-x0)/(x1-x0)*pw,lx2=m.l+(b-x0)/(x1-x0)*pw;ctx.fillRect(lx1,m.t,Math.max(1,lx2-lx1),ph)}ctx.font='12px system-ui';ctx.strokeStyle=border;ctx.fillStyle=text;ctx.lineWidth=1;for(let i=0;i<=4;i++){const y=m.t+ph*i/4;ctx.beginPath();ctx.moveTo(m.l,y);ctx.lineTo(w-m.r,y);ctx.stroke();const val=y1-(y1-y0)*i/4;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(val.toFixed(1),m.l-7,y)}const tickCount=6;for(let i=0;i<=tickCount;i++){const x=m.l+pw*i/tickCount;ctx.beginPath();ctx.moveTo(x,m.t);ctx.lineTo(x,m.t+ph);ctx.stroke();const ts=x0+(x1-x0)*i/tickCount;ctx.textAlign=i===0?'left':(i===tickCount?'right':'center');ctx.textBaseline='top';ctx.fillText(xLabel(ts,x0,x1,activeRange),x,m.t+ph+8)}if(pts.length){ctx.strokeStyle=accent;ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();let started=false,previousTimestamp=null;const maxGap=(historyData.bucketSeconds||120)*3;for(const p of pts){const x=m.l+(p[0]-x0)/(x1-x0)*pw,y=m.t+(y1-p[index])/(y1-y0)*ph;if(!started||previousTimestamp===null||p[0]-previousTimestamp>maxGap){ctx.moveTo(x,y);started=true}else ctx.lineTo(x,y);previousTimestamp=p[0]}ctx.stroke()}else{ctx.fillStyle=text;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('표시할 데이터가 없습니다.',m.l+pw/2,m.t+ph/2)}}
function drawAll(){drawChart('chartT',1,'temp');drawChart('chartH',2,'hum');drawChart('chartP',3,'pres')}document.querySelectorAll('button[data-range]').forEach(b=>b.addEventListener('click',()=>loadHistory(b.dataset.range)));window.addEventListener('resize',()=>requestAnimationFrame(drawAll));refreshCurrent();loadHistory('day');setInterval(refreshCurrent,15000);setInterval(()=>loadHistory(activeRange),120000);
</script></body></html>
)HTML";

bool isTimeValid(time_t value){return static_cast<uint32_t>(value)>=VALID_EPOCH_MIN;}
String formatLocalTime(time_t value){if(!isTimeValid(value))return String("--");struct tm t;localtime_r(&value,&t);char b[32];strftime(b,sizeof(b),"%Y-%m-%d %H:%M:%S",&t);return String(b);}
String lightRuntimeText(uint32_t minutes){char b[32];snprintf(b,sizeof(b),"%u시간 %u분",minutes/60UL,minutes%60UL);return String(b);}
String uptimeText(){uint64_t s=esp_timer_get_time()/1000000ULL;uint32_t d=s/86400ULL;uint8_t h=(s%86400ULL)/3600ULL,m=(s%3600ULL)/60ULL;char b[40];if(d>0)snprintf(b,sizeof(b),"%u일 %u시간 %u분",d,h,m);else snprintf(b,sizeof(b),"%u시간 %u분",h,m);return String(b);}
void serviceNetwork(){ArduinoOTA.handle();server.handleClient();delay(1);}
void servicedDelay(uint32_t ms){uint32_t st=millis();while(millis()-st<ms){serviceNetwork();delay(5);}}
bool validSensorData(float t,float h,float p){return isfinite(t)&&isfinite(h)&&isfinite(p)&&t>=-40&&t<=85&&h>=0&&h<=100&&p>=300&&p<=1100;}

bool connectWiFi(uint32_t timeoutMs=20000UL){if(WiFi.status()==WL_CONNECTED)return true;Serial.printf("Wi-Fi connecting to %s",WIFI_SSID);WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);WiFi.persistent(false);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);uint32_t st=millis();while(WiFi.status()!=WL_CONNECTED&&millis()-st<timeoutMs){Serial.print('.');delay(500);}if(WiFi.status()!=WL_CONNECTED){Serial.println("\nWi-Fi connection timed out.");return false;}Serial.println("\nWi-Fi connected.");Serial.print("IP: ");Serial.println(WiFi.localIP());Serial.printf("RSSI: %d dBm\n",WiFi.RSSI());return true;}
void maintainWiFi(){if(WiFi.status()==WL_CONNECTED)return;if(millis()-lastWiFiAttemptMs<WIFI_RECONNECT_INTERVAL_MS)return;lastWiFiAttemptMs=millis();Serial.println("Wi-Fi disconnected; reconnecting.");WiFi.disconnect();WiFi.begin(WIFI_SSID,WIFI_PASSWORD);}
void requestTimeSync(){if(WiFi.status()!=WL_CONNECTED)return;configTzTime(TZ_INFO,"pool.ntp.org","time.google.com","time.nist.gov");lastNtpRequestMs=millis();ntpRequestActive=true;Serial.println("NTP synchronization requested (non-blocking).");}
void maintainTimeSync(){time_t now=0;time(&now);if(isTimeValid(now)){if(!timeReady)Serial.printf("Time synchronized: %s\n",formatLocalTime(now).c_str());timeReady=true;ntpRequestActive=false;return;}timeReady=false;if(WiFi.status()!=WL_CONNECTED)return;if(!ntpRequestActive||millis()-lastNtpRequestMs>=NTP_RETRY_INTERVAL_MS)requestTimeSync();}
void setupOTA(){ArduinoOTA.setHostname(OTA_HOSTNAME);ArduinoOTA.setPassword(OTA_PASSWORD);ArduinoOTA.onStart([](){Serial.println("OTA start");});ArduinoOTA.onEnd([](){Serial.println("\nOTA completed.");});ArduinoOTA.onProgress([](unsigned int p,unsigned int total){Serial.printf("OTA progress: %u%%\r",(p/(total/100)));});ArduinoOTA.onError([](ota_error_t e){Serial.printf("OTA error[%u]\n",e);});ArduinoOTA.begin();otaReady=true;Serial.printf("OTA ready: %s.local\n",OTA_HOSTNAME);}
void setupMDNS(){if(MDNS.begin(OTA_HOSTNAME)){MDNS.addService("http","tcp",80);mdnsReady=true;Serial.printf("mDNS ready: http://%s.local/\n",OTA_HOSTNAME);}else Serial.println("mDNS start failed; use the numeric IP address.");}

bool initializeBME280(){if(bme.begin(0x76))bmeAddress=0x76;else if(bme.begin(0x77))bmeAddress=0x77;else{bmeAddress=0;Serial.println("BME280 not found.");return false;}bme.setSampling(Adafruit_BME280::MODE_FORCED,Adafruit_BME280::SAMPLING_X1,Adafruit_BME280::SAMPLING_X1,Adafruit_BME280::SAMPLING_X1,Adafruit_BME280::FILTER_X4,Adafruit_BME280::STANDBY_MS_0_5);Serial.printf("BME280 ready at 0x%02X\n",bmeAddress);return true;}
bool readBME280(float& t,float& h,float& p){if(bmeAddress==0&&!initializeBME280())return false;if(!bme.takeForcedMeasurement())return false;t=bme.readTemperature();h=bme.readHumidity();p=bme.readPressure()/100.0f;return validSensorData(t,h,p);}

bool takeMutex(SemaphoreHandle_t mutex, TickType_t waitTicks = portMAX_DELAY){
  return mutex == nullptr || xSemaphoreTake(mutex, waitTicks) == pdTRUE;
}
void giveMutex(SemaphoreHandle_t mutex){if(mutex != nullptr)xSemaphoreGive(mutex);}

bool readRecordAt(File& f,uint32_t slot,SensorRecord& r){size_t off=static_cast<size_t>(slot)*sizeof(SensorRecord);if(!f.seek(off,SeekSet))return false;return f.read(reinterpret_cast<uint8_t*>(&r),sizeof(r))==sizeof(r);}
bool writeRecordAt(File& f,uint32_t slot,const SensorRecord& r){size_t off=static_cast<size_t>(slot)*sizeof(SensorRecord);if(!f.seek(off,SeekSet))return false;return f.write(reinterpret_cast<const uint8_t*>(&r),sizeof(r))==sizeof(r);}
bool readLightEventAt(File& f,uint32_t slot,LightEvent& e){size_t off=static_cast<size_t>(slot)*sizeof(LightEvent);if(!f.seek(off,SeekSet))return false;return f.read(reinterpret_cast<uint8_t*>(&e),sizeof(e))==sizeof(e);}
bool writeLightEventAt(File& f,uint32_t slot,const LightEvent& e){size_t off=static_cast<size_t>(slot)*sizeof(LightEvent);if(!f.seek(off,SeekSet))return false;return f.write(reinterpret_cast<const uint8_t*>(&e),sizeof(e))==sizeof(e);}
bool ensureLightEventFile(){File f=LittleFS.open(LIGHT_EVENT_FILE_PATH,"r");size_t required=static_cast<size_t>(MAX_LIGHT_EVENTS)*sizeof(LightEvent),sz=f?f.size():0;if(f)f.close();if(sz==required)return true;Serial.printf("Creating light event file: %u bytes\n",(unsigned)required);f=LittleFS.open(LIGHT_EVENT_FILE_PATH,"w");if(!f)return false;if(!f.seek(required-1,SeekSet)){f.close();return false;}uint8_t z=0;bool ok=f.write(&z,1)==1;f.flush();f.close();return ok;}
bool scanLightEventFile(){
  newestLightEventSlot=-1;
  validLightEventCount=0;
  lightEventCacheCount=0;
  storedLightStateKnown=false;

  File f=LittleFS.open(LIGHT_EVENT_FILE_PATH,"r");
  if(!f)return false;

  uint32_t newestTs=0;
  LightEvent newest{};
  for(uint32_t slot=0;slot<MAX_LIGHT_EVENTS;slot++){
    LightEvent e{};
    if(!readLightEventAt(f,slot,e)){f.close();return false;}
    if(e.timestamp>=VALID_EPOCH_MIN&&e.state<=1){
      validLightEventCount++;
      if(e.timestamp>=newestTs){
        newestTs=e.timestamp;
        newestLightEventSlot=(int32_t)slot;
        newest=e;
      }
    }
  }

  if(validLightEventCount>0&&newestLightEventSlot>=0){
    uint32_t startSlot=validLightEventCount<MAX_LIGHT_EVENTS?0:((uint32_t)newestLightEventSlot+1UL)%MAX_LIGHT_EVENTS;
    uint32_t seen=0;
    for(uint32_t i=0;i<MAX_LIGHT_EVENTS&&seen<validLightEventCount;i++){
      uint32_t slot=(startSlot+i)%MAX_LIGHT_EVENTS;
      LightEvent e{};
      if(!readLightEventAt(f,slot,e)){f.close();return false;}
      if(e.timestamp<VALID_EPOCH_MIN||e.state>1)continue;
      lightEventCache[lightEventCacheCount++]=e;
      seen++;
    }
  }
  f.close();

  if(newestLightEventSlot>=0){
    storedLightStateKnown=true;
    lastStoredLightOn=newest.state==1;
    latestLightStateKnown=true;
    latestLightOn=lastStoredLightOn;
  }
  Serial.printf("Light event scan: %u events, newest slot %ld, RAM cache %u bytes\n",validLightEventCount,(long)newestLightEventSlot,(unsigned)(lightEventCacheCount*sizeof(LightEvent)));
  return true;
}
uint32_t oldestLightEventSlot(){if(validLightEventCount==0||newestLightEventSlot<0)return 0;if(validLightEventCount<MAX_LIGHT_EVENTS)return 0;return((uint32_t)newestLightEventSlot+1UL)%MAX_LIGHT_EVENTS;}
bool appendLightEvent(uint32_t timestamp,bool on,TickType_t waitTicks){
  if(!filesystemReady){Serial.println("Light event failed: filesystem not ready.");return false;}
  if(timestamp<VALID_EPOCH_MIN){Serial.println("Light event failed: invalid timestamp.");return false;}
  if(!takeMutex(fsMutex,waitTicks))return false;
  uint32_t next=newestLightEventSlot<0?0:((uint32_t)newestLightEventSlot+1UL)%MAX_LIGHT_EVENTS;
  File f=LittleFS.open(LIGHT_EVENT_FILE_PATH,"r+");
  if(!f){Serial.println("Light event failed: could not open event file.");giveMutex(fsMutex);return false;}
  LightEvent e{};e.timestamp=timestamp;e.state=on?1:0;
  bool ok=writeLightEventAt(f,next,e);
  if(!ok)Serial.printf("Light event failed: write error at slot %u, file size %u.\n",next,(unsigned)f.size());
  f.flush();f.close();
  if(ok){
    newestLightEventSlot=(int32_t)next;
    if(validLightEventCount<MAX_LIGHT_EVENTS)validLightEventCount++;
    if(lightEventCacheCount<MAX_LIGHT_EVENTS){
      lightEventCache[lightEventCacheCount++]=e;
    }else{
      memmove(&lightEventCache[0],&lightEventCache[1],(MAX_LIGHT_EVENTS-1)*sizeof(LightEvent));
      lightEventCache[MAX_LIGHT_EVENTS-1]=e;
    }
  }
  giveMutex(fsMutex);
  if(ok)Serial.printf("Light event: %s at %s (RAM cache: %u)\n",on?"ON":"OFF",formatLocalTime(timestamp).c_str(),(unsigned)lightEventCacheCount);
  return ok;
}
uint32_t localMidnight(uint32_t timestamp){time_t t=(time_t)timestamp;struct tm local{};localtime_r(&t,&local);local.tm_hour=0;local.tm_min=0;local.tm_sec=0;return(uint32_t)mktime(&local);}
void scheduleObservedLightState(uint32_t sampleTimestamp,bool on,uint32_t minutesToday){
  bool shouldSchedule=false,storedKnown=false;
  if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);
  storedKnown=storedLightStateKnown;
  shouldSchedule=(!storedLightStateKnown||lastStoredLightOn!=on)&&(!pendingLightEvent||pendingLightEventOn!=on);
  if(stateMutex)xSemaphoreGive(stateMutex);
  if(!shouldSchedule)return;

  uint32_t eventTimestamp=sampleTimestamp;
  if(!storedKnown&&validLightEventCount==0&&on&&minutesToday>0){
    uint32_t midnight=localMidnight(sampleTimestamp);
    uint64_t runtimeSeconds=(uint64_t)minutesToday*60ULL;
    uint64_t elapsedToday=sampleTimestamp>=midnight?(uint64_t)(sampleTimestamp-midnight):0ULL;
    if(runtimeSeconds>elapsedToday)runtimeSeconds=elapsedToday;
    eventTimestamp=sampleTimestamp-(uint32_t)runtimeSeconds;
    if(eventTimestamp<midnight)eventTimestamp=midnight;
    Serial.printf("Initial light ON inferred from daily runtime: %s (%u min).\n",formatLocalTime(eventTimestamp).c_str(),(unsigned)minutesToday);
  }

  if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);
  if((!storedLightStateKnown||lastStoredLightOn!=on)&&(!pendingLightEvent||pendingLightEventOn!=on)){
    pendingLightEvent=true;
    pendingLightEventTimestamp=eventTimestamp;
    pendingLightEventOn=on;
    lastPendingLightWriteAttemptMs=0;
    Serial.printf("Light event queued in RAM: %s at %s\n",on?"ON":"OFF",formatLocalTime(eventTimestamp).c_str());
  }
  if(stateMutex)xSemaphoreGive(stateMutex);
}
void processPendingLightEventWrite(){
  if(!filesystemReady)return;
  uint32_t nowMs=millis();
  if(lastPendingLightWriteAttemptMs!=0&&nowMs-lastPendingLightWriteAttemptMs<PENDING_LIGHT_WRITE_RETRY_MS)return;

  bool hasPending=false,on=false;uint32_t timestamp=0;
  if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);
  hasPending=pendingLightEvent;timestamp=pendingLightEventTimestamp;on=pendingLightEventOn;
  if(stateMutex)xSemaphoreGive(stateMutex);
  if(!hasPending)return;

  lastPendingLightWriteAttemptMs=nowMs;
  if(!appendLightEvent(timestamp,on,0)){
    if(nowMs-lastPendingLightBusyLogMs>=PENDING_LIGHT_BUSY_LOG_INTERVAL_MS){
      Serial.println("Light event pending: LittleFS busy; main loop will keep retrying.");
      lastPendingLightBusyLogMs=nowMs;
    }
    return;
  }

  if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);
  storedLightStateKnown=true;
  lastStoredLightOn=on;
  if(pendingLightEvent&&pendingLightEventTimestamp==timestamp&&pendingLightEventOn==on)pendingLightEvent=false;
  if(stateMutex)xSemaphoreGive(stateMutex);
}
bool ensureRingFile(){if(!filesystemReady)return false;File f=LittleFS.open(LOG_FILE_PATH,"r");size_t sz=f?f.size():0;if(f)f.close();if(sz==REQUIRED_LOG_BYTES)return true;Serial.printf("Creating ring file: %u bytes\n",(unsigned)REQUIRED_LOG_BYTES);f=LittleFS.open(LOG_FILE_PATH,"w");if(!f)return false;if(!f.seek(REQUIRED_LOG_BYTES-1,SeekSet)){f.close();return false;}uint8_t z=0;if(f.write(&z,1)!=1){f.close();return false;}f.flush();f.close();return true;}
bool scanRingFile(){newestSlot=-1;validRecordCount=0;File f=LittleFS.open(LOG_FILE_PATH,"r");if(!f)return false;uint32_t newestTs=0;for(uint32_t slot=0;slot<MAX_RECORDS;slot++){SensorRecord r{};if(!readRecordAt(f,slot,r)){f.close();return false;}if(r.timestamp>=VALID_EPOCH_MIN&&(r.flags&FLAG_SENSOR_VALID)){validRecordCount++;if(r.timestamp>=newestTs){newestTs=r.timestamp;newestSlot=(int32_t)slot;}}if((slot&0x3FF)==0)yield();}f.close();Serial.printf("Ring scan: %u records, newest slot %ld\n",validRecordCount,(long)newestSlot);return true;}
bool initializeFilesystem(){if(!LittleFS.begin(true)){Serial.println("LittleFS mount failed.");return false;}filesystemReady=true;Serial.printf("Flash: %u bytes\n",ESP.getFlashChipSize());Serial.printf("LittleFS total: %u bytes\n",LittleFS.totalBytes());Serial.printf("LittleFS used: %u bytes\n",LittleFS.usedBytes());Serial.printf("Ring required: %u bytes\n",(unsigned)REQUIRED_LOG_BYTES);constexpr size_t MARGIN=64UL*1024UL;if(LittleFS.totalBytes()<REQUIRED_LOG_BYTES+MARGIN){Serial.println("ERROR: LittleFS partition is too small for 30 days.");filesystemReady=false;return false;}if(!takeMutex(fsMutex))return false;bool ok=ensureRingFile()&&scanRingFile()&&ensureLightEventFile()&&scanLightEventFile();giveMutex(fsMutex);return ok;}
bool appendRecord(const SensorRecord& r,uint32_t& writtenSlot){if(!filesystemReady)return false;if(!takeMutex(fsMutex,pdMS_TO_TICKS(1000)))return false;uint32_t next=newestSlot<0?0:((uint32_t)newestSlot+1UL)%MAX_RECORDS;File f=LittleFS.open(LOG_FILE_PATH,"r+");if(!f){giveMutex(fsMutex);return false;}bool ok=writeRecordAt(f,next,r);f.flush();f.close();if(ok){newestSlot=(int32_t)next;if(validRecordCount<MAX_RECORDS)validRecordCount++;writtenSlot=next;}giveMutex(fsMutex);return ok;}
uint32_t oldestSlot(){if(validRecordCount==0||newestSlot<0)return 0;if(validRecordCount<MAX_RECORDS)return 0;return((uint32_t)newestSlot+1UL)%MAX_RECORDS;}
bool markRecordCloudOk(uint32_t slot,uint32_t expectedTimestamp){if(!filesystemReady||slot>=MAX_RECORDS)return false;if(!takeMutex(fsMutex,pdMS_TO_TICKS(1000)))return false;File f=LittleFS.open(LOG_FILE_PATH,"r+");if(!f){giveMutex(fsMutex);return false;}SensorRecord r{};bool ok=readRecordAt(f,slot,r);if(ok&&r.timestamp==expectedTimestamp&&(r.flags&FLAG_SENSOR_VALID)){r.flags|=FLAG_CLOUD_OK;ok=writeRecordAt(f,slot,r);}else ok=false;f.flush();f.close();giveMutex(fsMutex);return ok;}
template<typename Callback>void forEachRecordChronological(Callback cb){if(!filesystemReady||validRecordCount==0)return;if(!takeMutex(fsMutex))return;File f=LittleFS.open(LOG_FILE_PATH,"r");if(!f){giveMutex(fsMutex);return;}uint32_t start=oldestSlot(),seen=0;for(uint32_t i=0;i<MAX_RECORDS&&seen<validRecordCount;i++){uint32_t slot=(start+i)%MAX_RECORDS;SensorRecord r{};if(!readRecordAt(f,slot,r))break;if(r.timestamp>=VALID_EPOCH_MIN&&(r.flags&FLAG_SENSOR_VALID)){seen++;if(!cb(r))break;}if((i&0xFF)==0)yield();}f.close();giveMutex(fsMutex);}

void clearCacheBucket(CacheBucket& bucket,uint32_t bucketStart){bucket.bucketStart=bucketStart;bucket.count=0;bucket.reserved=0;bucket.sumT=0;bucket.sumH=0;bucket.sumP=0;}
template<size_t N>void addToCache(CacheBucket (&cache)[N],uint32_t bucketSeconds,const SensorRecord& r){uint32_t bucketStart=(r.timestamp/bucketSeconds)*bucketSeconds;size_t index=(bucketStart/bucketSeconds)%N;CacheBucket& b=cache[index];if(b.bucketStart!=bucketStart)clearCacheBucket(b,bucketStart);if(b.count<UINT16_MAX)b.count++;b.sumT+=r.temperature;b.sumH+=r.humidity;b.sumP+=r.pressure;}
void addRecordToCaches(const SensorRecord& r){if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);addToCache(dayCache,DAY_BUCKET_SECONDS,r);addToCache(weekCache,WEEK_BUCKET_SECONDS,r);addToCache(monthCache,MONTH_BUCKET_SECONDS,r);if(stateMutex)xSemaphoreGive(stateMutex);}
bool rebuildHistoryCaches(){if(!filesystemReady)return false;Serial.println("Building RAM history caches...");if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);memset(dayCache,0,sizeof(dayCache));memset(weekCache,0,sizeof(weekCache));memset(monthCache,0,sizeof(monthCache));historyCacheReady=false;if(stateMutex)xSemaphoreGive(stateMutex);forEachRecordChronological([&](const SensorRecord& r){addRecordToCaches(r);return true;});if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);historyCacheReady=true;if(stateMutex)xSemaphoreGive(stateMutex);Serial.printf("History cache ready: day=%u, week=%u, month=%u buckets\n",(unsigned)DAY_CACHE_SIZE,(unsigned)WEEK_CACHE_SIZE,(unsigned)MONTH_CACHE_SIZE);return true;}

int uploadToThingSpeak(const ThingSpeakJob& job){if(WiFi.status()!=WL_CONNECTED)return-1000;int code=-1;for(uint8_t a=1;a<=MAX_UPLOAD_ATTEMPTS;a++){ThingSpeak.setField(1,job.record.temperature);ThingSpeak.setField(2,job.record.humidity);ThingSpeak.setField(3,job.record.pressure);ThingSpeak.setField(4,(long)job.record.rssi);ThingSpeak.setField(5,job.uptimeHours);ThingSpeak.setStatus("Sensor online");code=ThingSpeak.writeFields(THINGSPEAK_CHANNEL_ID,THINGSPEAK_WRITE_API_KEY);if(code==200){Serial.printf("ThingSpeak upload succeeded on attempt %u.\n",a);return code;}Serial.printf("ThingSpeak attempt %u failed: %d\n",a,code);if(a<MAX_UPLOAD_ATTEMPTS)vTaskDelay(pdMS_TO_TICKS(UPLOAD_RETRY_DELAY_MS));}return code;}

void thingSpeakTask(void* parameter){thingSpeakTaskRunning=true;ThingSpeakJob job{};for(;;){if(xQueueReceive(thingSpeakQueue,&job,portMAX_DELAY)!=pdTRUE)continue;int code=uploadToThingSpeak(job);bool cloudOk=code==200;if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);latestThingSpeakCode=code;if(cloudOk)consecutiveUploadFailures=0;else if(consecutiveUploadFailures<UINT32_MAX)consecutiveUploadFailures++;if(stateMutex)xSemaphoreGive(stateMutex);if(cloudOk&&job.slot<MAX_RECORDS&&!markRecordCloudOk(job.slot,job.record.timestamp))Serial.println("Failed to update local cloud-success flag.");if(!cloudOk)Serial.printf("Cloud upload failed; local record retained. Consecutive failures: %lu\n",(unsigned long)consecutiveUploadFailures);}}

bool setupThingSpeakTask(){thingSpeakQueue=xQueueCreate(THINGSPEAK_QUEUE_LENGTH,sizeof(ThingSpeakJob));if(!thingSpeakQueue){Serial.println("ERROR: ThingSpeak queue creation failed.");return false;}BaseType_t ok=xTaskCreatePinnedToCore(thingSpeakTask,"ThingSpeak",THINGSPEAK_TASK_STACK,nullptr,1,&thingSpeakTaskHandle,0);if(ok!=pdPASS){Serial.println("ERROR: ThingSpeak task creation failed.");vQueueDelete(thingSpeakQueue);thingSpeakQueue=nullptr;return false;}Serial.println("ThingSpeak task started.");return true;}

bool queueThingSpeakUpload(const SensorRecord& record,uint32_t slot){if(!thingSpeakQueue)return false;ThingSpeakJob job{};job.record=record;job.slot=slot;job.uptimeHours=(float)(esp_timer_get_time()/1000000ULL)/3600.0f;if(xQueueSend(thingSpeakQueue,&job,0)==pdTRUE)return true;droppedUploadJobs++;Serial.printf("ThingSpeak queue full; dropped upload job. Total dropped: %lu\n",(unsigned long)droppedUploadJobs);return false;}

String makeSwitchBotNonce(){char b[33];for(int i=0;i<4;i++)snprintf(b+i*8,9,"%08lx",(unsigned long)esp_random());return String(b);}
bool makeSwitchBotSignature(const String& timestampMs,const String& nonce,String& signature){String source=String(SWITCHBOT_TOKEN)+timestampMs+nonce;unsigned char digest[32];const mbedtls_md_info_t* info=mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);if(!info)return false;if(mbedtls_md_hmac(info,reinterpret_cast<const unsigned char*>(SWITCHBOT_SECRET),strlen(SWITCHBOT_SECRET),reinterpret_cast<const unsigned char*>(source.c_str()),source.length(),digest)!=0)return false;unsigned char output[64];size_t outLen=0;if(mbedtls_base64_encode(output,sizeof(output),&outLen,digest,sizeof(digest))!=0)return false;output[outLen]='\0';signature=String(reinterpret_cast<char*>(output));return true;}
bool extractJsonString(const String& json,const char* key,String& value){String token=String("\"")+key+"\"";int p=json.indexOf(token);if(p<0)return false;p=json.indexOf(':',p+token.length());if(p<0)return false;p=json.indexOf('"',p+1);if(p<0)return false;int e=json.indexOf('"',p+1);if(e<0)return false;value=json.substring(p+1,e);return true;}
bool extractJsonNumber(const String& json,const char* key,double& value){String token=String("\"")+key+"\"";int p=json.indexOf(token);if(p<0)return false;p=json.indexOf(':',p+token.length());if(p<0)return false;p++;while(p<(int)json.length()&&(json[p]==' '||json[p]=='\t'))p++;int e=p;while(e<(int)json.length()&&(isDigit(json[e])||json[e]=='-'||json[e]=='+'||json[e]=='.'))e++;if(e==p)return false;value=json.substring(p,e).toDouble();return true;}
bool querySwitchBot(uint32_t sampleTimestamp){if(WiFi.status()!=WL_CONNECTED||sampleTimestamp<VALID_EPOCH_MIN)return false;uint64_t ms=(uint64_t)time(nullptr)*1000ULL;char tsBuffer[24];snprintf(tsBuffer,sizeof(tsBuffer),"%llu",(unsigned long long)ms);String ts(tsBuffer),nonce=makeSwitchBotNonce(),sign;if(!makeSwitchBotSignature(ts,nonce,sign)){Serial.println("SwitchBot signature creation failed.");return false;}WiFiClientSecure client;client.setInsecure();HTTPClient http;String url=String("https://api.switch-bot.com/v1.1/devices/")+SWITCHBOT_DEVICE_ID+"/status";if(!http.begin(client,url)){Serial.println("SwitchBot HTTP begin failed.");return false;}http.setTimeout(SWITCHBOT_HTTP_TIMEOUT_MS);http.addHeader("Authorization",SWITCHBOT_TOKEN);http.addHeader("sign",sign);http.addHeader("t",ts);http.addHeader("nonce",nonce);http.addHeader("Content-Type","application/json; charset=utf8");int httpCode=http.GET();String body=httpCode>0?http.getString():String();http.end();double apiStatus=0,voltage=0,power=0,currentMa=0,minutesToday=0;String powerState;bool parsed=httpCode==200&&extractJsonNumber(body,"statusCode",apiStatus)&&apiStatus==100&&extractJsonString(body,"power",powerState)&&extractJsonNumber(body,"voltage",voltage)&&extractJsonNumber(body,"weight",power)&&extractJsonNumber(body,"electricCurrent",currentMa)&&extractJsonNumber(body,"electricityOfDay",minutesToday);if(!parsed){if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);latestSwitchBotHttpCode=httpCode;latestSwitchBotStatusCode=(int)apiStatus;if(consecutiveSwitchBotFailures<UINT32_MAX)consecutiveSwitchBotFailures++;if(stateMutex)xSemaphoreGive(stateMutex);Serial.printf("SwitchBot query failed: HTTP %d, API %.0f\n",httpCode,apiStatus);return false;}bool on=powerState=="on";uint32_t runtimeMinutes=(uint32_t)minutesToday;if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);latestLightStateKnown=true;latestLightOn=on;latestLightVoltage=(float)voltage;latestLightPower=(float)power;latestLightCurrentA=(float)(currentMa/1000.0);latestLightMinutesToday=runtimeMinutes;latestSwitchBotUpdateTime=sampleTimestamp;latestSwitchBotHttpCode=httpCode;latestSwitchBotStatusCode=(int)apiStatus;consecutiveSwitchBotFailures=0;if(stateMutex)xSemaphoreGive(stateMutex);scheduleObservedLightState(sampleTimestamp,on,runtimeMinutes);Serial.printf("SwitchBot: %s, %.1f W, %.1f V, %.3f A, %u min today\n",on?"ON":"OFF",power,voltage,currentMa/1000.0,(unsigned)runtimeMinutes);return true;}
void switchBotTask(void* parameter){switchBotTaskRunning=true;SwitchBotJob job{};for(;;){if(xQueueReceive(switchBotQueue,&job,portMAX_DELAY)==pdTRUE)querySwitchBot(job.sampleTimestamp);}}
bool setupSwitchBotTask(){switchBotQueue=xQueueCreate(SWITCHBOT_QUEUE_LENGTH,sizeof(SwitchBotJob));if(!switchBotQueue){Serial.println("ERROR: SwitchBot queue creation failed.");return false;}BaseType_t ok=xTaskCreatePinnedToCore(switchBotTask,"SwitchBot",SWITCHBOT_TASK_STACK,nullptr,1,&switchBotTaskHandle,0);if(ok!=pdPASS){Serial.println("ERROR: SwitchBot task creation failed.");vQueueDelete(switchBotQueue);switchBotQueue=nullptr;return false;}Serial.println("SwitchBot task started.");return true;}
bool queueSwitchBotQuery(uint32_t sampleTimestamp){if(!switchBotQueue)return false;SwitchBotJob job{sampleTimestamp};if(xQueueSend(switchBotQueue,&job,0)==pdTRUE)return true;Serial.println("SwitchBot query skipped: previous query still pending.");return false;}

RangeSettings historyRange(const String& range,time_t now){RangeSettings s{};if(range=="day"){struct tm t;localtime_r(&now,&t);t.tm_hour=0;t.tm_min=0;t.tm_sec=0;s.start=mktime(&t);t.tm_mday+=1;s.end=mktime(&t);s.bucketSeconds=DAY_BUCKET_SECONDS;}else if(range=="week"){s.end=now;s.start=now-7L*24L*3600L;s.bucketSeconds=WEEK_BUCKET_SECONDS;}else{s.end=now;s.start=now-30L*24L*3600L;s.bucketSeconds=MONTH_BUCKET_SECONDS;}return s;}

template<size_t N>void sendCacheJson(CacheBucket (&cache)[N],const RangeSettings& s){bool first=true;for(uint32_t ts=(uint32_t)s.start-(uint32_t)s.start%s.bucketSeconds;ts<(uint32_t)s.end;ts+=s.bucketSeconds){size_t index=(ts/s.bucketSeconds)%N;CacheBucket b{};if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);b=cache[index];if(stateMutex)xSemaphoreGive(stateMutex);if(b.bucketStart!=ts||b.count==0)continue;uint32_t pointTs=ts+s.bucketSeconds/2;char line[112];snprintf(line,sizeof(line),"%s[%u,%.3f,%.3f,%.3f]",first?"":",",pointTs,b.sumT/b.count,b.sumH/b.count,b.sumP/b.count);server.sendContent(line);first=false;yield();}}

void sendLightIntervalsJson(const RangeSettings& s){
  bool first=true;
  if(lightEventCacheCount==0)return;

  time_t now;
  time(&now);
  uint32_t visibleEnd=(uint32_t)s.end;
  if(isTimeValid(now)&&(uint32_t)now<visibleEnd)visibleEnd=(uint32_t)now;
  if(visibleEnd<=(uint32_t)s.start)return;

  bool stateKnown=false,stateOn=false;
  uint32_t onStart=0;
  for(uint32_t i=0;i<lightEventCacheCount;i++){
    const LightEvent& e=lightEventCache[i];
    if(e.timestamp<VALID_EPOCH_MIN||e.state>1)continue;
    if(e.timestamp<=(uint32_t)s.start){
      stateKnown=true;
      stateOn=e.state==1;
      if(stateOn)onStart=(uint32_t)s.start;
      continue;
    }
    if(e.timestamp>=visibleEnd)break;
    if(!stateKnown){
      stateKnown=true;
      stateOn=e.state==1;
      if(stateOn)onStart=e.timestamp;
      continue;
    }
    bool nextOn=e.state==1;
    if(stateOn&&!nextOn){
      char line[64];
      snprintf(line,sizeof(line),"%s[%u,%u]",first?"":",",onStart,e.timestamp);
      server.sendContent(line);
      first=false;
    }else if(!stateOn&&nextOn){
      onStart=e.timestamp;
    }
    stateOn=nextOn;
  }
  if(stateKnown&&stateOn&&onStart<visibleEnd){
    char line[64];
    snprintf(line,sizeof(line),"%s[%u,%u]",first?"":",",onStart,visibleEnd);
    server.sendContent(line);
  }
}

void handleRoot(){server.send_P(200,"text/html; charset=utf-8",DASHBOARD_HTML);}
void handleCurrent(){time_t now;time(&now);float t,h,p,lv,lp,lc;int rssi,cloudCode,sbHttp,sbStatus;time_t measured,sbUpdated;uint32_t failureStreak,sbFailures,lightMinutes;bool lightKnown,lightOn,lightEventPendingSnapshot;if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);t=latestTemperature;h=latestHumidity;p=latestPressure;rssi=latestRssi;cloudCode=latestThingSpeakCode;measured=latestMeasurementTime;failureStreak=consecutiveUploadFailures;lightKnown=latestLightStateKnown;lightOn=latestLightOn;lv=latestLightVoltage;lp=latestLightPower;lc=latestLightCurrentA;lightMinutes=latestLightMinutesToday;sbUpdated=latestSwitchBotUpdateTime;sbHttp=latestSwitchBotHttpCode;sbStatus=latestSwitchBotStatusCode;sbFailures=consecutiveSwitchBotFailures;lightEventPendingSnapshot=pendingLightEvent;if(stateMutex)xSemaphoreGive(stateMutex);String j;j.reserve(900);j+="{";j+="\"temperature\":";j+=isfinite(t)?String(t,2):"null";j+=",\"humidity\":";j+=isfinite(h)?String(h,2):"null";j+=",\"pressure\":";j+=isfinite(p)?String(p,2):"null";j+=",\"rssi\":"+String(WiFi.status()==WL_CONNECTED?WiFi.RSSI():rssi);j+=",\"uptimeText\":\""+uptimeText()+"\"";j+=",\"cloudOk\":";j+=cloudCode==200?"true":"false";j+=",\"cloudCode\":"+String(cloudCode);j+=",\"measurementTime\":\""+formatLocalTime(measured)+"\"";j+=",\"deviceTime\":\""+formatLocalTime(now)+"\"";j+=",\"lightKnown\":";j+=lightKnown?"true":"false";j+=",\"lightOn\":";j+=lightOn?"true":"false";j+=",\"lightVoltage\":";j+=isfinite(lv)?String(lv,1):"null";j+=",\"lightPower\":";j+=isfinite(lp)?String(lp,1):"null";j+=",\"lightCurrent\":";j+=isfinite(lc)?String(lc,3):"null";j+=",\"lightRuntimeText\":\""+lightRuntimeText(lightMinutes)+"\"";j+=",\"switchBotOk\":";j+=(sbHttp==200&&sbStatus==100)?"true":"false";j+=",\"switchBotHttpCode\":"+String(sbHttp);j+=",\"switchBotStatusCode\":"+String(sbStatus);j+=",\"switchBotUpdateTime\":\""+formatLocalTime(sbUpdated)+"\"";j+=",\"switchBotFailures\":"+String(sbFailures);j+=",\"records\":"+String(validRecordCount);j+=",\"lightEvents\":"+String(validLightEventCount);j+=",\"lightEventCache\":"+String(lightEventCacheCount);j+=",\"lightEventPending\":";j+=lightEventPendingSnapshot?"true":"false";j+=",\"cloudFailureStreak\":"+String(failureStreak);j+=",\"uploadQueue\":"+String(thingSpeakQueue?uxQueueMessagesWaiting(thingSpeakQueue):0);j+=",\"droppedUploads\":"+String(droppedUploadJobs);j+=",\"cacheReady\":";j+=historyCacheReady?"true":"false";j+="}";server.send(200,"application/json; charset=utf-8",j);}
void handleHistory(){if(!historyCacheReady){server.send(503,"application/json","{\"error\":\"History cache is still building\"}");return;}time_t now;time(&now);if(!isTimeValid(now)){server.send(503,"application/json","{\"error\":\"Time not synchronized\"}");return;}String range=server.hasArg("range")?server.arg("range"):"day";if(range!="day"&&range!="week"&&range!="month")range="day";RangeSettings s=historyRange(range,now);server.setContentLength(CONTENT_LENGTH_UNKNOWN);server.send(200,"application/json; charset=utf-8","");char head[160];snprintf(head,sizeof(head),"{\"range\":\"%s\",\"start\":%u,\"end\":%u,\"bucketSeconds\":%u,\"points\":[",range.c_str(),(uint32_t)s.start,(uint32_t)s.end,(uint32_t)s.bucketSeconds);server.sendContent(head);if(range=="day")sendCacheJson(dayCache,s);else if(range=="week")sendCacheJson(weekCache,s);else sendCacheJson(monthCache,s);server.sendContent("],\"lightIntervals\":[");sendLightIntervalsJson(s);server.sendContent("]}");server.sendContent("");}
void handleCsvDownload(){
  if(!filesystemReady){server.send(503,"text/plain","LittleFS unavailable");return;}
  time_t now;time(&now);time_t cutoff=now-30L*24L*3600L;
  uint32_t snapshotStart=0,snapshotCount=0;
  if(!takeMutex(fsMutex,pdMS_TO_TICKS(1000))){server.send(503,"text/plain","Storage busy");return;}
  snapshotStart=oldestSlot();snapshotCount=validRecordCount;
  giveMutex(fsMutex);
  server.sendHeader("Content-Disposition","attachment; filename=\"hydroponics_30days.csv\"");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200,"text/csv; charset=utf-8","");
  server.sendContent("timestamp_local,epoch,temperature_C,humidity_percent,pressure_hPa,rssi_dBm,cloud_ok\n");
  constexpr size_t CSV_BATCH_SIZE=32;
  SensorRecord batch[CSV_BATCH_SIZE];
  uint32_t physicalOffset=0,validSeen=0;
  while(physicalOffset<MAX_RECORDS&&validSeen<snapshotCount){
    size_t batchCount=0;
    if(!takeMutex(fsMutex,pdMS_TO_TICKS(1000))){Serial.println("CSV read paused: LittleFS busy.");delay(10);continue;}
    File f=LittleFS.open(LOG_FILE_PATH,"r");
    if(!f){giveMutex(fsMutex);break;}
    while(physicalOffset<MAX_RECORDS&&validSeen<snapshotCount&&batchCount<CSV_BATCH_SIZE){
      uint32_t slot=(snapshotStart+physicalOffset)%MAX_RECORDS;physicalOffset++;
      SensorRecord r{};
      if(!readRecordAt(f,slot,r))break;
      if(r.timestamp>=VALID_EPOCH_MIN&&(r.flags&FLAG_SENSOR_VALID)){validSeen++;batch[batchCount++]=r;}
    }
    f.close();giveMutex(fsMutex);
    for(size_t i=0;i<batchCount;i++){
      const SensorRecord& r=batch[i];if(r.timestamp<(uint32_t)cutoff)continue;
      String local=formatLocalTime(r.timestamp);char line[150];
      snprintf(line,sizeof(line),"%s,%u,%.3f,%.3f,%.3f,%d,%u\n",local.c_str(),r.timestamp,r.temperature,r.humidity,r.pressure,r.rssi,(r.flags&FLAG_CLOUD_OK)?1:0);
      server.sendContent(line);
    }
    yield();
  }
  server.sendContent("");
}
void handleNotFound(){server.send(404,"text/plain; charset=utf-8","Not found");}
void setupWebServer(){server.on("/",HTTP_GET,handleRoot);server.on("/api/current",HTTP_GET,handleCurrent);server.on("/api/history",HTTP_GET,handleHistory);server.on("/download.csv",HTTP_GET,handleCsvDownload);server.onNotFound(handleNotFound);server.begin();Serial.println("HTTP server started.");}

void performMeasurementCycle(){time_t now;time(&now);if(!isTimeValid(now))maintainTimeSync();time(&now);float t=NAN,h=NAN,p=NAN;if(!readBME280(t,h,p)){consecutiveSensorFailures++;bmeAddress=0;Serial.printf("Invalid sensor read (%u/%u).\n",consecutiveSensorFailures,MAX_CONSECUTIVE_SENSOR_FAILURES);if(consecutiveSensorFailures>=MAX_CONSECUTIVE_SENSOR_FAILURES){servicedDelay(1000);ESP.restart();}return;}consecutiveSensorFailures=0;int rssi=WiFi.status()==WL_CONNECTED?WiFi.RSSI():0;if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);latestTemperature=t;latestHumidity=h;latestPressure=p;latestRssi=rssi;latestMeasurementTime=isTimeValid(now)?now:0;if(stateMutex)xSemaphoreGive(stateMutex);Serial.println("--------------------------------");Serial.printf("Time: %s\n",formatLocalTime(now).c_str());Serial.printf("Temperature: %.2f C\nHumidity: %.2f %%\nPressure: %.2f hPa\nRSSI: %d dBm\n",t,h,p,rssi);SensorRecord r{};r.timestamp=(uint32_t)now;r.temperature=t;r.humidity=h;r.pressure=p;r.rssi=(int8_t)constrain(rssi,-127,0);r.flags=FLAG_SENSOR_VALID;bool localSaved=false;uint32_t writtenSlot=UINT32_MAX;if(filesystemReady&&isTimeValid(now)){localSaved=appendRecord(r,writtenSlot);if(localSaved)addRecordToCaches(r);else Serial.println("Local record append failed.");}queueSwitchBotQuery((uint32_t)now);if(!queueThingSpeakUpload(r,localSaved?writtenSlot:UINT32_MAX)){if(stateMutex)xSemaphoreTake(stateMutex,portMAX_DELAY);latestThingSpeakCode=-2000;if(consecutiveUploadFailures<UINT32_MAX)consecutiveUploadFailures++;if(stateMutex)xSemaphoreGive(stateMutex);}}

void setup(){Serial.begin(115200);delay(800);Serial.println("\nESP32 hydroponics logger v7.2.2 starting.");fsMutex=xSemaphoreCreateMutex();stateMutex=xSemaphoreCreateMutex();if(!fsMutex||!stateMutex)Serial.println("WARNING: mutex creation failed.");Wire.begin(I2C_SDA_PIN,I2C_SCL_PIN);initializeBME280();connectWiFi();if(WiFi.status()==WL_CONNECTED){requestTimeSync();setupOTA();setupMDNS();}thingSpeakClient.setTimeout(3000);ThingSpeak.begin(thingSpeakClient);initializeFilesystem();rebuildHistoryCaches();Serial.printf("RAM cache bytes: history=%u, light=%u, free heap before task: %u bytes\n",(unsigned)(sizeof(dayCache)+sizeof(weekCache)+sizeof(monthCache)),(unsigned)sizeof(lightEventCache),ESP.getFreeHeap());setupThingSpeakTask();setupSwitchBotTask();setupWebServer();lastSampleMs=millis()-SAMPLE_INTERVAL_MS;Serial.println("Setup complete.");}
void loop(){maintainWiFi();if(WiFi.status()==WL_CONNECTED){maintainTimeSync();if(!otaReady)setupOTA();if(!mdnsReady)setupMDNS();}processPendingLightEventWrite();serviceNetwork();if(millis()-lastSampleMs>=SAMPLE_INTERVAL_MS){lastSampleMs=millis();performMeasurementCycle();}processPendingLightEventWrite();delay(5);}
