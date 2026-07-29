/*
  ESP32 + BME280 Hydroponics Environment Logger v5
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
  - HTTP history/CSV generation avoids recursive WebServer handling
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
#include <time.h>

// ================= USER SETTINGS =================
const char* TZ_INFO = "JST-9";

constexpr int I2C_SDA_PIN = 18;
constexpr int I2C_SCL_PIN = 19;
constexpr uint32_t SAMPLE_INTERVAL_MS = 120000UL;
constexpr uint8_t MAX_UPLOAD_ATTEMPTS = 1;
constexpr uint32_t UPLOAD_RETRY_DELAY_MS = 0UL;
constexpr uint8_t MAX_CONSECUTIVE_SENSOR_FAILURES = 5;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000UL;

// ================= 30-DAY RING BUFFER =================
constexpr uint32_t RECORDS_PER_DAY = 24UL * 60UL / 2UL;
constexpr uint32_t MAX_RECORDS = 30UL * RECORDS_PER_DAY;
constexpr const char* LOG_FILE_PATH = "/sensor_ring.bin";
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

typedef struct {
  time_t start;
  time_t end;
  uint32_t bucketSeconds;
} RangeSettings;

typedef struct {
  uint32_t bucketIndex;
  uint32_t count;
  double sumT;
  double sumH;
  double sumP;
  double sumRssi;
  bool initialized;
} BucketAccumulator;

RangeSettings historyRange(const String& range, time_t now);
void resetBucket(BucketAccumulator& bucket, uint32_t index);
void sendJsonPoint(const RangeSettings& settings,
                   const BucketAccumulator& bucket,
                   bool& firstPoint);

constexpr size_t REQUIRED_LOG_BYTES =
  static_cast<size_t>(MAX_RECORDS) * sizeof(SensorRecord);

int32_t newestSlot = -1;
uint32_t validRecordCount = 0;

Adafruit_BME280 bme;
WiFiClient thingSpeakClient;
WebServer server(80);

uint8_t bmeAddress = 0;
bool filesystemReady = false;
bool timeReady = false;
bool otaReady = false;
bool mdnsReady = false;

uint32_t lastSampleMs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t consecutiveUploadFailures = 0;
uint8_t consecutiveSensorFailures = 0;

float latestTemperature = NAN;
float latestHumidity = NAN;
float latestPressure = NAN;
int latestRssi = 0;
int latestThingSpeakCode = 0;
time_t latestMeasurementTime = 0;

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
</section>
<div class="toolbar"><button data-range="day" class="active">오늘 0–24시</button><button data-range="week">최근 7일</button><button data-range="month">최근 30일</button><a class="button" href="/download.csv">30일 CSV</a><span id="state">그래프 준비 중…</span></div>
<section class="panel"><h2>온도 (°C)</h2><canvas id="chartT"></canvas></section>
<section class="panel"><h2>습도 (%)</h2><canvas id="chartH"></canvas></section>
<section class="panel"><h2>기압 (hPa)</h2><canvas id="chartP"></canvas></section>
<footer>오늘 화면의 시간축은 항상 현지시간 00:00–24:00으로 고정됩니다. 7일은 10분 평균, 30일은 30분 평균입니다. Y축은 데이터에 따라 움직이되 최소 표시 폭을 유지합니다.</footer>
</main><script>
let activeRange="day",historyData={start:0,end:1,points:[]};const $=id=>document.getElementById(id);const fmt=(v,n=1)=>Number.isFinite(v)?v.toFixed(n):"--";
async function refreshCurrent(){try{const r=await fetch('/api/current',{cache:'no-store'}),d=await r.json();$('temp').textContent=fmt(d.temperature,2);$('hum').textContent=fmt(d.humidity,2);$('pres').textContent=fmt(d.pressure,2);$('rssi').textContent=d.rssi??'--';$('uptime').textContent=d.uptimeText||'--';$('cloud').textContent=d.cloudOk?'정상':('오류 '+d.cloudCode);$('clock').textContent='마지막 측정: '+(d.measurementTime||'--')+' · 장치 시각: '+(d.deviceTime||'--')}catch(e){$('clock').textContent='현재 상태를 불러오지 못했습니다.'}}
async function loadHistory(range){activeRange=range;document.querySelectorAll('button[data-range]').forEach(b=>b.classList.toggle('active',b.dataset.range===range));$('state').textContent='데이터 불러오는 중…';try{const r=await fetch('/api/history?range='+range,{cache:'no-store'});historyData=await r.json();$('state').textContent=historyData.points.length.toLocaleString()+'개 점';drawAll()}catch(e){$('state').textContent='그래프 데이터 오류'}}
function niceBounds(values,type){let minSpan,step,emptyBounds;if(type==='temp'){minSpan=10;step=2.5;emptyBounds=[15,35]}else if(type==='hum'){minSpan=20;step=5;emptyBounds=[30,80]}else{minSpan=40;step=10;emptyBounds=[980,1040]}if(!values.length)return emptyBounds;const rawLo=Math.min(...values),rawHi=Math.max(...values),rawSpan=rawHi-rawLo,padding=rawSpan>0?rawSpan*.12:0,center=(rawLo+rawHi)/2,span=Math.max(rawSpan+padding*2,minSpan);let lo=center-span/2,hi=center+span/2;lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;if(hi-lo<minSpan)hi=lo+minSpan;return[lo,hi]}
function xLabel(ts,start,end,range){if(range==='day'){const h=(ts-start)/3600;return Math.round(h)+':00'}const d=new Date(ts*1000);return(d.getMonth()+1)+'/'+d.getDate()}
function drawChart(canvasId,index,type){const canvas=$(canvasId),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height,css=getComputedStyle(document.documentElement),text=css.getPropertyValue('--muted').trim(),border=css.getPropertyValue('--border').trim(),accent=css.getPropertyValue('--accent').trim();ctx.clearRect(0,0,w,h);const m={l:55,r:15,t:12,b:33},pw=w-m.l-m.r,ph=h-m.t-m.b,pts=historyData.points.filter(p=>Number.isFinite(p[index])),vals=pts.map(p=>p[index]),[y0,y1]=niceBounds(vals,type),x0=historyData.start,x1=historyData.end;ctx.font='12px system-ui';ctx.strokeStyle=border;ctx.fillStyle=text;ctx.lineWidth=1;for(let i=0;i<=4;i++){const y=m.t+ph*i/4;ctx.beginPath();ctx.moveTo(m.l,y);ctx.lineTo(w-m.r,y);ctx.stroke();const val=y1-(y1-y0)*i/4;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(val.toFixed(1),m.l-7,y)}const tickCount=6;for(let i=0;i<=tickCount;i++){const x=m.l+pw*i/tickCount;ctx.beginPath();ctx.moveTo(x,m.t);ctx.lineTo(x,m.t+ph);ctx.stroke();const ts=x0+(x1-x0)*i/tickCount;ctx.textAlign=i===0?'left':(i===tickCount?'right':'center');ctx.textBaseline='top';ctx.fillText(xLabel(ts,x0,x1,activeRange),x,m.t+ph+8)}if(pts.length){ctx.strokeStyle=accent;ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();let started=false;for(const p of pts){const x=m.l+(p[0]-x0)/(x1-x0)*pw,y=m.t+(y1-p[index])/(y1-y0)*ph;if(!started){ctx.moveTo(x,y);started=true}else ctx.lineTo(x,y)}ctx.stroke()}else{ctx.fillStyle=text;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('표시할 데이터가 없습니다.',m.l+pw/2,m.t+ph/2)}}
function drawAll(){drawChart('chartT',1,'temp');drawChart('chartH',2,'hum');drawChart('chartP',3,'pres')}document.querySelectorAll('button[data-range]').forEach(b=>b.addEventListener('click',()=>loadHistory(b.dataset.range)));window.addEventListener('resize',()=>requestAnimationFrame(drawAll));refreshCurrent();loadHistory('day');setInterval(refreshCurrent,15000);setInterval(()=>loadHistory(activeRange),120000);
</script></body></html>
)HTML";

bool isTimeValid(time_t value){return static_cast<uint32_t>(value)>=VALID_EPOCH_MIN;}
String formatLocalTime(time_t value){if(!isTimeValid(value))return String("--");struct tm t;localtime_r(&value,&t);char b[32];strftime(b,sizeof(b),"%Y-%m-%d %H:%M:%S",&t);return String(b);}
String uptimeText(){uint64_t s=esp_timer_get_time()/1000000ULL;uint32_t d=s/86400ULL;uint8_t h=(s%86400ULL)/3600ULL,m=(s%3600ULL)/60ULL;char b[40];if(d>0)snprintf(b,sizeof(b),"%u일 %u시간 %u분",d,h,m);else snprintf(b,sizeof(b),"%u시간 %u분",h,m);return String(b);}
void serviceNetwork(){ArduinoOTA.handle();server.handleClient();delay(1);}
void servicedDelay(uint32_t ms){uint32_t st=millis();while(millis()-st<ms){serviceNetwork();delay(5);}}
bool validSensorData(float t,float h,float p){return isfinite(t)&&isfinite(h)&&isfinite(p)&&t>=-40&&t<=85&&h>=0&&h<=100&&p>=300&&p<=1100;}

bool connectWiFi(uint32_t timeoutMs=20000UL){if(WiFi.status()==WL_CONNECTED)return true;Serial.printf("Wi-Fi connecting to %s",WIFI_SSID);WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);WiFi.persistent(false);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);uint32_t st=millis();while(WiFi.status()!=WL_CONNECTED&&millis()-st<timeoutMs){Serial.print('.');delay(500);}if(WiFi.status()!=WL_CONNECTED){Serial.println("\nWi-Fi connection timed out.");return false;}Serial.println("\nWi-Fi connected.");Serial.print("IP: ");Serial.println(WiFi.localIP());Serial.printf("RSSI: %d dBm\n",WiFi.RSSI());return true;}
void maintainWiFi(){if(WiFi.status()==WL_CONNECTED)return;if(millis()-lastWiFiAttemptMs<WIFI_RECONNECT_INTERVAL_MS)return;lastWiFiAttemptMs=millis();Serial.println("Wi-Fi disconnected; reconnecting.");WiFi.disconnect();WiFi.begin(WIFI_SSID,WIFI_PASSWORD);}
bool synchronizeTime(uint32_t timeoutMs=15000UL){if(WiFi.status()!=WL_CONNECTED)return false;configTzTime(TZ_INFO,"pool.ntp.org","time.google.com","time.nist.gov");Serial.print("Waiting for NTP time");uint32_t st=millis();time_t now=0;while(millis()-st<timeoutMs){time(&now);if(isTimeValid(now)){timeReady=true;Serial.printf("\nTime synchronized: %s\n",formatLocalTime(now).c_str());return true;}Serial.print('.');delay(500);}Serial.println("\nNTP synchronization timed out.");return false;}
void setupOTA(){ArduinoOTA.setHostname(OTA_HOSTNAME);ArduinoOTA.setPassword(OTA_PASSWORD);ArduinoOTA.onStart([](){Serial.println("OTA start");});ArduinoOTA.onEnd([](){Serial.println("\nOTA completed.");});ArduinoOTA.onProgress([](unsigned int p,unsigned int total){Serial.printf("OTA progress: %u%%\r",(p/(total/100)));});ArduinoOTA.onError([](ota_error_t e){Serial.printf("OTA error[%u]\n",e);});ArduinoOTA.begin();otaReady=true;Serial.printf("OTA ready: %s.local\n",OTA_HOSTNAME);}
void setupMDNS(){if(MDNS.begin(OTA_HOSTNAME)){MDNS.addService("http","tcp",80);mdnsReady=true;Serial.printf("mDNS ready: http://%s.local/\n",OTA_HOSTNAME);}else Serial.println("mDNS start failed; use the numeric IP address.");}

bool initializeBME280(){if(bme.begin(0x76))bmeAddress=0x76;else if(bme.begin(0x77))bmeAddress=0x77;else{bmeAddress=0;Serial.println("BME280 not found.");return false;}bme.setSampling(Adafruit_BME280::MODE_FORCED,Adafruit_BME280::SAMPLING_X1,Adafruit_BME280::SAMPLING_X1,Adafruit_BME280::SAMPLING_X1,Adafruit_BME280::FILTER_X4,Adafruit_BME280::STANDBY_MS_0_5);Serial.printf("BME280 ready at 0x%02X\n",bmeAddress);return true;}
bool readBME280(float& t,float& h,float& p){if(bmeAddress==0&&!initializeBME280())return false;if(!bme.takeForcedMeasurement())return false;t=bme.readTemperature();h=bme.readHumidity();p=bme.readPressure()/100.0f;return validSensorData(t,h,p);}

bool readRecordAt(File& f,uint32_t slot,SensorRecord& r){size_t off=static_cast<size_t>(slot)*sizeof(SensorRecord);if(!f.seek(off,SeekSet))return false;return f.read(reinterpret_cast<uint8_t*>(&r),sizeof(r))==sizeof(r);}
bool writeRecordAt(File& f,uint32_t slot,const SensorRecord& r){size_t off=static_cast<size_t>(slot)*sizeof(SensorRecord);if(!f.seek(off,SeekSet))return false;return f.write(reinterpret_cast<const uint8_t*>(&r),sizeof(r))==sizeof(r);}
bool ensureRingFile(){if(!filesystemReady)return false;File f=LittleFS.open(LOG_FILE_PATH,"r");size_t sz=f?f.size():0;if(f)f.close();if(sz==REQUIRED_LOG_BYTES)return true;Serial.printf("Creating ring file: %u bytes\n",(unsigned)REQUIRED_LOG_BYTES);f=LittleFS.open(LOG_FILE_PATH,"w");if(!f)return false;if(!f.seek(REQUIRED_LOG_BYTES-1,SeekSet)){f.close();return false;}uint8_t z=0;if(f.write(&z,1)!=1){f.close();return false;}f.flush();f.close();return true;}
bool scanRingFile(){newestSlot=-1;validRecordCount=0;File f=LittleFS.open(LOG_FILE_PATH,"r");if(!f)return false;uint32_t newestTs=0;for(uint32_t slot=0;slot<MAX_RECORDS;slot++){SensorRecord r{};if(!readRecordAt(f,slot,r)){f.close();return false;}if(r.timestamp>=VALID_EPOCH_MIN&&(r.flags&FLAG_SENSOR_VALID)){validRecordCount++;if(r.timestamp>=newestTs){newestTs=r.timestamp;newestSlot=(int32_t)slot;}}if((slot&0x3FF)==0)serviceNetwork();}f.close();Serial.printf("Ring scan: %u records, newest slot %ld\n",validRecordCount,(long)newestSlot);return true;}
bool initializeFilesystem(){if(!LittleFS.begin(true)){Serial.println("LittleFS mount failed.");return false;}filesystemReady=true;Serial.printf("Flash: %u bytes\n",ESP.getFlashChipSize());Serial.printf("LittleFS total: %u bytes\n",LittleFS.totalBytes());Serial.printf("LittleFS used: %u bytes\n",LittleFS.usedBytes());Serial.printf("Ring required: %u bytes\n",(unsigned)REQUIRED_LOG_BYTES);constexpr size_t MARGIN=64UL*1024UL;if(LittleFS.totalBytes()<REQUIRED_LOG_BYTES+MARGIN){Serial.println("ERROR: LittleFS partition is too small for 30 days.");filesystemReady=false;return false;}return ensureRingFile()&&scanRingFile();}
bool appendRecord(const SensorRecord& r){if(!filesystemReady)return false;uint32_t next=newestSlot<0?0:((uint32_t)newestSlot+1UL)%MAX_RECORDS;File f=LittleFS.open(LOG_FILE_PATH,"r+");if(!f)return false;bool ok=writeRecordAt(f,next,r);f.flush();f.close();if(!ok)return false;newestSlot=(int32_t)next;if(validRecordCount<MAX_RECORDS)validRecordCount++;return true;}
uint32_t oldestSlot(){if(validRecordCount==0||newestSlot<0)return 0;if(validRecordCount<MAX_RECORDS)return 0;return((uint32_t)newestSlot+1UL)%MAX_RECORDS;}
bool markNewestRecordCloudOk(){
  if(!filesystemReady||newestSlot<0)return false;
  File f=LittleFS.open(LOG_FILE_PATH,"r+");
  if(!f)return false;
  SensorRecord r{};
  bool ok=readRecordAt(f,(uint32_t)newestSlot,r);
  if(ok){
    r.flags|=FLAG_CLOUD_OK;
    ok=writeRecordAt(f,(uint32_t)newestSlot,r);
  }
  f.flush();
  f.close();
  return ok;
}
template<typename Callback>void forEachRecordChronological(Callback cb){if(!filesystemReady||validRecordCount==0)return;File f=LittleFS.open(LOG_FILE_PATH,"r");if(!f)return;uint32_t start=oldestSlot(),seen=0;for(uint32_t i=0;i<MAX_RECORDS&&seen<validRecordCount;i++){uint32_t slot=(start+i)%MAX_RECORDS;SensorRecord r{};if(!readRecordAt(f,slot,r))break;if(r.timestamp>=VALID_EPOCH_MIN&&(r.flags&FLAG_SENSOR_VALID)){seen++;if(!cb(r))break;}if((i&0xFF)==0)yield();}f.close();}

int uploadToThingSpeak(float t,float h,float p,int rssi){if(WiFi.status()!=WL_CONNECTED)return-1000;float up=(float)(esp_timer_get_time()/1000000ULL)/3600.0f;int code=-1;for(uint8_t a=1;a<=MAX_UPLOAD_ATTEMPTS;a++){ThingSpeak.setField(1,t);ThingSpeak.setField(2,h);ThingSpeak.setField(3,p);ThingSpeak.setField(4,(long)rssi);ThingSpeak.setField(5,up);ThingSpeak.setStatus("Sensor online");code=ThingSpeak.writeFields(THINGSPEAK_CHANNEL_ID,THINGSPEAK_WRITE_API_KEY);if(code==200){Serial.printf("ThingSpeak upload succeeded on attempt %u.\n",a);return code;}Serial.printf("ThingSpeak attempt %u failed: %d\n",a,code);if(a<MAX_UPLOAD_ATTEMPTS)servicedDelay(UPLOAD_RETRY_DELAY_MS);}return code;}

RangeSettings historyRange(const String& range,time_t now){RangeSettings s{};if(range=="day"){struct tm t;localtime_r(&now,&t);t.tm_hour=0;t.tm_min=0;t.tm_sec=0;s.start=mktime(&t);t.tm_mday+=1;s.end=mktime(&t);s.bucketSeconds=120;}else if(range=="week"){s.end=now;s.start=now-7L*24L*3600L;s.bucketSeconds=600;}else{s.end=now;s.start=now-30L*24L*3600L;s.bucketSeconds=1800;}return s;}
void resetBucket(BucketAccumulator& b,uint32_t idx){b.bucketIndex=idx;b.count=0;b.sumT=b.sumH=b.sumP=b.sumRssi=0;b.initialized=true;}
void sendJsonPoint(const RangeSettings& s,const BucketAccumulator& b,bool& first){if(!b.initialized||b.count==0)return;uint32_t ts=(uint32_t)s.start+b.bucketIndex*s.bucketSeconds+s.bucketSeconds/2;char line[128];snprintf(line,sizeof(line),"%s[%u,%.3f,%.3f,%.3f,%.1f]",first?"":",",ts,b.sumT/b.count,b.sumH/b.count,b.sumP/b.count,b.sumRssi/b.count);server.sendContent(line);first=false;}

void handleRoot(){server.send_P(200,"text/html; charset=utf-8",DASHBOARD_HTML);}
void handleCurrent(){time_t now;time(&now);String j;j.reserve(420);j+="{";j+="\"temperature\":";j+=isfinite(latestTemperature)?String(latestTemperature,2):"null";j+=",\"humidity\":";j+=isfinite(latestHumidity)?String(latestHumidity,2):"null";j+=",\"pressure\":";j+=isfinite(latestPressure)?String(latestPressure,2):"null";j+=",\"rssi\":"+String(WiFi.status()==WL_CONNECTED?WiFi.RSSI():latestRssi);j+=",\"uptimeText\":\""+uptimeText()+"\"";j+=",\"cloudOk\":";j+=latestThingSpeakCode==200?"true":"false";j+=",\"cloudCode\":"+String(latestThingSpeakCode);j+=",\"measurementTime\":\""+formatLocalTime(latestMeasurementTime)+"\"";j+=",\"deviceTime\":\""+formatLocalTime(now)+"\"";j+=",\"records\":"+String(validRecordCount);j+=",\"cloudFailureStreak\":"+String(consecutiveUploadFailures);j+="}";server.send(200,"application/json; charset=utf-8",j);}
void handleHistory(){if(!filesystemReady){server.send(503,"application/json","{\"error\":\"LittleFS unavailable\"}");return;}time_t now;time(&now);if(!isTimeValid(now)){server.send(503,"application/json","{\"error\":\"Time not synchronized\"}");return;}String range=server.hasArg("range")?server.arg("range"):"day";if(range!="day"&&range!="week"&&range!="month")range="day";RangeSettings s=historyRange(range,now);server.setContentLength(CONTENT_LENGTH_UNKNOWN);server.send(200,"application/json; charset=utf-8","");char head[128];snprintf(head,sizeof(head),"{\"range\":\"%s\",\"start\":%u,\"end\":%u,\"points\":[",range.c_str(),(uint32_t)s.start,(uint32_t)s.end);server.sendContent(head);BucketAccumulator b{};bool first=true;forEachRecordChronological([&](const SensorRecord& r){if(r.timestamp<(uint32_t)s.start||r.timestamp>=(uint32_t)s.end)return true;uint32_t idx=(r.timestamp-(uint32_t)s.start)/s.bucketSeconds;if(!b.initialized)resetBucket(b,idx);else if(idx!=b.bucketIndex){sendJsonPoint(s,b,first);resetBucket(b,idx);}b.count++;b.sumT+=r.temperature;b.sumH+=r.humidity;b.sumP+=r.pressure;b.sumRssi+=r.rssi;return true;});sendJsonPoint(s,b,first);server.sendContent("]}");server.sendContent("");}
void handleCsvDownload(){if(!filesystemReady){server.send(503,"text/plain","LittleFS unavailable");return;}time_t now;time(&now);time_t cutoff=now-30L*24L*3600L;server.sendHeader("Content-Disposition","attachment; filename=\"hydroponics_30days.csv\"");server.setContentLength(CONTENT_LENGTH_UNKNOWN);server.send(200,"text/csv; charset=utf-8","");server.sendContent("timestamp_local,epoch,temperature_C,humidity_percent,pressure_hPa,rssi_dBm,cloud_ok\n");forEachRecordChronological([&](const SensorRecord& r){if(r.timestamp<(uint32_t)cutoff)return true;String local=formatLocalTime(r.timestamp);char line[150];snprintf(line,sizeof(line),"%s,%u,%.3f,%.3f,%.3f,%d,%u\n",local.c_str(),r.timestamp,r.temperature,r.humidity,r.pressure,r.rssi,(r.flags&FLAG_CLOUD_OK)?1:0);server.sendContent(line);return true;});server.sendContent("");}
void handleNotFound(){server.send(404,"text/plain; charset=utf-8","Not found");}
void setupWebServer(){server.on("/",HTTP_GET,handleRoot);server.on("/api/current",HTTP_GET,handleCurrent);server.on("/api/history",HTTP_GET,handleHistory);server.on("/download.csv",HTTP_GET,handleCsvDownload);server.onNotFound(handleNotFound);server.begin();Serial.println("HTTP server started.");}

void performMeasurementCycle(){time_t now;time(&now);if(!isTimeValid(now)){timeReady=synchronizeTime();time(&now);}float t=NAN,h=NAN,p=NAN;if(!readBME280(t,h,p)){consecutiveSensorFailures++;bmeAddress=0;Serial.printf("Invalid sensor read (%u/%u).\n",consecutiveSensorFailures,MAX_CONSECUTIVE_SENSOR_FAILURES);if(consecutiveSensorFailures>=MAX_CONSECUTIVE_SENSOR_FAILURES){servicedDelay(1000);ESP.restart();}return;}consecutiveSensorFailures=0;latestTemperature=t;latestHumidity=h;latestPressure=p;latestRssi=WiFi.status()==WL_CONNECTED?WiFi.RSSI():0;latestMeasurementTime=isTimeValid(now)?now:0;Serial.println("--------------------------------");Serial.printf("Time: %s\n",formatLocalTime(now).c_str());Serial.printf("Temperature: %.2f C\nHumidity: %.2f %%\nPressure: %.2f hPa\nRSSI: %d dBm\n",t,h,p,latestRssi);SensorRecord r{};
  r.timestamp=(uint32_t)now;
  r.temperature=t;
  r.humidity=h;
  r.pressure=p;
  r.rssi=(int8_t)constrain(latestRssi,-127,0);
  r.flags=FLAG_SENSOR_VALID;

  bool localSaved=false;
  if(filesystemReady&&isTimeValid(now)){
    localSaved=appendRecord(r);
    if(!localSaved)Serial.println("Local record append failed.");
  }

  int code=uploadToThingSpeak(t,h,p,latestRssi);
  latestThingSpeakCode=code;
  bool cloudOk=code==200;
  if(cloudOk){
    consecutiveUploadFailures=0;
    if(localSaved&&!markNewestRecordCloudOk()){
      Serial.println("Failed to update local cloud-success flag.");
    }
  }else if(consecutiveUploadFailures<UINT32_MAX){
    consecutiveUploadFailures++;
  }

  // The sample is already preserved locally before any cloud request.
  // FLAG_CLOUD_OK is not rewritten in-place; current upload state is shown separately.
if(!cloudOk){
    Serial.printf("Cloud upload failed; local record retained. Consecutive failures: %lu\\n",
                  (unsigned long)consecutiveUploadFailures);
  }}

void setup(){Serial.begin(115200);delay(800);Serial.println("\nESP32 hydroponics logger starting.");Wire.begin(I2C_SDA_PIN,I2C_SCL_PIN);initializeBME280();connectWiFi();if(WiFi.status()==WL_CONNECTED){synchronizeTime();setupOTA();setupMDNS();}thingSpeakClient.setTimeout(3000);
  ThingSpeak.begin(thingSpeakClient);setupWebServer();initializeFilesystem();lastSampleMs=millis()-SAMPLE_INTERVAL_MS;Serial.println("Setup complete.");}
void loop(){maintainWiFi();if(WiFi.status()==WL_CONNECTED){if(!timeReady){time_t now;time(&now);if(isTimeValid(now))timeReady=true;else synchronizeTime(5000);}if(!otaReady)setupOTA();if(!mdnsReady)setupMDNS();}serviceNetwork();if(millis()-lastSampleMs>=SAMPLE_INTERVAL_MS){lastSampleMs=millis();performMeasurementCycle();}delay(5);}
