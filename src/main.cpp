/*
  ESP32 + BME280 Hydroponics Environment Logger v8.4.0
  --------------------------------------------------
  Cloudflare-native release. Physical sensor values are sent to the Cloudflare
  ingestion API. ArduinoOTA and the 14-day LittleFS sensor ring remain available,
  while the ESP-hosted dashboard and HTTP API stay removed to reduce firmware
  size and runtime memory use.

  Each ring record carries a stable boot/sequence identity, all available sensor
  telemetry and a Cloudflare acknowledgement flag. SwitchBot observation and
  control are owned by the Cloudflare Worker.
*/

#include <Arduino.h>
#include "secrets.h"
#include "record_codec.h"
#include "ring_storage.h"
#include "sensor_manager.h"
#include "telemetry_record.h"
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <string.h>
#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#ifndef CLOUDFLARE_INGEST_URL
#define CLOUDFLARE_INGEST_URL \
  "https://hydroponics-jma-weather.flammenwerfer41.workers.dev/v1/readings"
#endif

#ifndef CLOUDFLARE_DEVICE_TOKEN
#define CLOUDFLARE_DEVICE_TOKEN ""
#endif

// Trust both workers.dev TLS 1.2 paths currently served by Cloudflare. Some
// edges send the WE1 chain through the cross-signed GTS Root R4 to the legacy
// GlobalSign Root R1, while desktop clients can build an alternate path to the
// GlobalSign ECC Root R4. Verification still fails closed for other chains.
const char CLOUDFLARE_ROOT_CAS[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIB3DCCAYOgAwIBAgINAgPlfvU/k/2lCSGypjAKBggqhkjOPQQDAjBQMSQwIgYD
VQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2Jh
bFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMTIxMTEzMDAwMDAwWhcNMzgw
MTE5MDMxNDA3WjBQMSQwIgYDVQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0g
UjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAAS4xnnTj2wlDp8uORkcA6SumuU5BwkWymOx
uYb4ilfBV85C+nOh92VC/x7BALJucw7/xyHlGKSq2XE/qNS5zowdo0IwQDAOBgNV
HQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUVLB7rUW44kB/
+wpu+74zyTyjhNUwCgYIKoZIzj0EAwIDRwAwRAIgIk90crlgr/HmnKAWBVBfw147
bmF0774BxL4YSFlhgjICICadVGNA3jdgUM/I2O2dgq43mLyjj0xMqTQrbO/7lZsm
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkG
A1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jv
b3QgQ0ExGzAZBgNVBAMTEkdsb2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAw
MDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9i
YWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJHbG9iYWxT
aWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaDuaZ
jc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavp
xy0Sy6scTHAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp
1Wrjsok6Vjk4bwY8iGlbKk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdG
snUOhugZitVtbNV4FpWi6cgKOOvyJBNPc1STE4U6G7weNLWLBYy5d4ux2x8gkasJ
U26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrXgzT/LCrBbBlDSgeF59N8
9iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8E
BTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0B
AQUFAAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOz
yj1hTdNGCbM+w6DjY1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE
38NflNUVyRRBnMRddWQVDf9VMOyGj/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymP
AbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhHhm4qxFYxldBniYUr+WymXUad
DKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveCX4XSQRjbgbME
HMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==
-----END CERTIFICATE-----
)EOF";

// ================= USER SETTINGS =================
const char* TZ_INFO = "JST-9";

constexpr uint32_t SAMPLE_INTERVAL_MS = 120000UL;
constexpr uint8_t MAX_CONSECUTIVE_SENSOR_FAILURES = 5;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000UL;
constexpr uint32_t NTP_RETRY_INTERVAL_MS = 300000UL;
constexpr uint32_t OTA_RECEIVE_TIMEOUT_MS = 8000UL;
constexpr uint8_t CLOUDFLARE_QUEUE_LENGTH = 4;
constexpr uint32_t CLOUDFLARE_TASK_STACK = 8192;
constexpr uint8_t CLOUDFLARE_BULK_BATCH_SIZE = 15;
constexpr uint32_t CLOUDFLARE_HTTP_TIMEOUT_MS = 15000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_INITIAL_MS = 30000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_MAX_MS = 30UL * 60UL * 1000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_JITTER_MS = 5000UL;

constexpr uint32_t VALID_EPOCH_MIN = 1704067200UL;
constexpr const char* FIRMWARE_VERSION = "8.4.0";
constexpr uint32_t FIRMWARE_VERSION_CODE = (8UL << 16) | (4UL << 8);

QueueHandle_t cloudflareQueue = nullptr;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t cloudflareTaskHandle = nullptr;

bool timeReady = false;
bool otaReady = false;
volatile bool otaInProgress = false;
wifi_ps_type_t otaPreviousSleepMode = WIFI_PS_MIN_MODEM;
bool previousWiFiConnected = false;

uint32_t lastSampleMs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastNtpRequestMs = 0;
bool ntpRequestActive = false;
uint8_t consecutiveBme280Failures = 0;
uint32_t consecutiveWaterTemperatureFailures = 0;
uint32_t droppedUploadJobs = 0;
StoredRecordRef bulkUploadBatch[CLOUDFLARE_BULK_BATCH_SIZE]{};
uint32_t consecutiveCloudflareFailures = 0;
uint32_t cloudflareRecoveryBackoffMs = 0;
uint32_t nextCloudflareRecoveryMs = 0;
uint64_t currentBootId = 0;
uint32_t nextReadingSequence = 0;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

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

uint64_t makeBootId() {
  uint64_t randomValue =
    (static_cast<uint64_t>(esp_random()) << 32) | esp_random();
  uint64_t value = randomValue ^ ESP.getEfuseMac();
  return value == 0 ? 1 : value;
}

void serviceNetwork() {
  if (otaReady) ArduinoOTA.handle();
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
      Serial.println("Wi-Fi reconnected.");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
    }
    return;
  }

  if (previousWiFiConnected) {
    previousWiFiConnected = false;
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
  ArduinoOTA.setTimeout(OTA_RECEIVE_TIMEOUT_MS);
  ArduinoOTA.onStart([]() {
    otaInProgress = true;
    otaPreviousSleepMode = WiFi.getSleep();
    WiFi.setSleep(WIFI_PS_NONE);
    Serial.println("OTA start; cloud tasks paused and Wi-Fi sleep disabled.");
  });
  ArduinoOTA.onEnd([]() {
    otaInProgress = false;
    Serial.println("\nOTA completed.");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    unsigned int percent = total > 0 ? static_cast<unsigned int>((uint64_t)progress * 100ULL / total) : 0;
    Serial.printf("OTA progress: %u%%\r", percent);
  });
  ArduinoOTA.onError([](ota_error_t error) {
    otaInProgress = false;
    WiFi.setSleep(otaPreviousSleepMode);
    Serial.printf("OTA error[%u]; cloud tasks resumed.\n", error);
  });
  ArduinoOTA.begin();
  otaReady = true;
  Serial.printf("OTA ready: %s.local\n", OTA_HOSTNAME);
}

// ================= CLOUDFLARE INGESTION =================
bool cloudflareConfigured() {
  return strncmp(CLOUDFLARE_INGEST_URL, "https://", 8) == 0 &&
         strlen(CLOUDFLARE_DEVICE_TOKEN) >= 24;
}

bool deadlineReached(uint32_t deadline) {
  return deadline == 0 || static_cast<int32_t>(millis() - deadline) >= 0;
}

void resetCloudflareBackoff() {
  cloudflareRecoveryBackoffMs = 0;
  nextCloudflareRecoveryMs = 0;
}

void scheduleCloudflareBackoff() {
  if (cloudflareRecoveryBackoffMs == 0) {
    cloudflareRecoveryBackoffMs = CLOUDFLARE_BACKOFF_INITIAL_MS;
  } else {
    uint64_t doubled = static_cast<uint64_t>(cloudflareRecoveryBackoffMs) * 2ULL;
    cloudflareRecoveryBackoffMs = doubled > CLOUDFLARE_BACKOFF_MAX_MS
      ? CLOUDFLARE_BACKOFF_MAX_MS
      : static_cast<uint32_t>(doubled);
  }
  uint32_t jitter = CLOUDFLARE_BACKOFF_JITTER_MS == 0
    ? 0
    : esp_random() % CLOUDFLARE_BACKOFF_JITTER_MS;
  nextCloudflareRecoveryMs = millis() + cloudflareRecoveryBackoffMs + jitter;
  Serial.printf("Cloudflare recovery backoff: %lu ms.\n",
                static_cast<unsigned long>(cloudflareRecoveryBackoffMs + jitter));
}

int postCloudflarePayload(const String& url, const String& payload, String& response) {
  if (!cloudflareConfigured() || WiFi.status() != WL_CONNECTED || otaInProgress) return -1000;
  WiFiClientSecure client;
  client.setCACert(CLOUDFLARE_ROOT_CAS);
  HTTPClient http;
  if (!http.begin(client, url)) {
    Serial.println("Cloudflare HTTP begin failed.");
    return -1001;
  }
  http.setTimeout(CLOUDFLARE_HTTP_TIMEOUT_MS);
  http.addHeader("Authorization", String("Bearer ") + CLOUDFLARE_DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(payload);
  response = code > 0 ? http.getString() : String();
  http.end();
  return code;
}

bool uploadToCloudflare(const SensorRecord& record) {
  if (!cloudflareConfigured()) return false;
  String payload;
  if (!payload.reserve(480) || !appendCloudflareReadingJson(payload, record)) {
    Serial.println("Cloudflare upload skipped: payload allocation or formatting failed.");
    return false;
  }
  String response;
  int code = postCloudflarePayload(CLOUDFLARE_INGEST_URL, payload, response);
  bool acknowledged = (code == 200 || code == 201) &&
                      responseAcknowledgesReading(response, record);
  if (acknowledged) {
    Serial.printf("Cloudflare acknowledged reading %lu.\n",
                  static_cast<unsigned long>(record.sequence));
  } else {
    Serial.printf("Cloudflare upload not acknowledged: HTTP %d.\n", code);
  }
  return acknowledged;
}

void recoverPendingCloudflareRecords() {
  if (!cloudflareConfigured() || !deadlineReached(nextCloudflareRecoveryMs) ||
      WiFi.status() != WL_CONNECTED || otaInProgress) return;
  size_t count = ring_storage::collectPendingDestinationRecords(
    bulkUploadBatch, CLOUDFLARE_BULK_BATCH_SIZE, FLAG_CLOUDFLARE_OK);
  if (count == 0) {
    resetCloudflareBackoff();
    return;
  }

  String payload;
  if (!payload.reserve(96 + count * 430U)) {
    Serial.println("Cloudflare recovery skipped: insufficient heap for JSON payload.");
    scheduleCloudflareBackoff();
    return;
  }
  payload += F("{\"schema_version\":1,\"readings\":[");
  size_t appended = 0;
  for (size_t index = 0; index < count; ++index) {
    if (appended > 0) payload += ',';
    if (appendCloudflareReadingJson(payload, bulkUploadBatch[index].record)) appended++;
  }
  payload += F("]}");
  if (appended != count) {
    Serial.println("Cloudflare recovery formatting failed; records remain pending.");
    scheduleCloudflareBackoff();
    return;
  }

  Serial.printf("Cloudflare recovery: uploading %u oldest pending records.\n",
                static_cast<unsigned>(count));
  String response;
  int code = postCloudflarePayload(
    String(CLOUDFLARE_INGEST_URL) + F("/bulk"), payload, response);
  if (code != 200) {
    Serial.printf("Cloudflare recovery failed: HTTP %d.\n", code);
    scheduleCloudflareBackoff();
    return;
  }

  size_t acknowledged = 0;
  for (size_t index = 0; index < count; ++index) {
    if (!responseAcknowledgesReading(response, bulkUploadBatch[index].record)) continue;
    if (acknowledged != index) bulkUploadBatch[acknowledged] = bulkUploadBatch[index];
    acknowledged++;
  }
  size_t marked = ring_storage::markRecordsDestinationOk(
    bulkUploadBatch, acknowledged, FLAG_CLOUDFLARE_OK);
  Serial.printf("Cloudflare recovery: %u acknowledged, %u marked complete.\n",
                static_cast<unsigned>(acknowledged), static_cast<unsigned>(marked));
  if (acknowledged == count && marked == acknowledged) resetCloudflareBackoff();
  else scheduleCloudflareBackoff();
}

// ================= CLOUDFLARE UPLOAD TASK =================
void cloudflareTask(void* parameter) {
  CloudflareJob job{};
  for (;;) {
    if (xQueueReceive(cloudflareQueue, &job, portMAX_DELAY) != pdTRUE) continue;
    while (otaInProgress) vTaskDelay(pdMS_TO_TICKS(100));
    bool cloudflareOk = uploadToCloudflare(job.record);

    if (takeMutex(stateMutex, portMAX_DELAY)) {
      if (cloudflareOk) consecutiveCloudflareFailures = 0;
      else if (consecutiveCloudflareFailures < UINT32_MAX) consecutiveCloudflareFailures++;
      giveMutex(stateMutex);
    }

    if (cloudflareOk && ring_storage::validSlot(job.slot) &&
        !ring_storage::markRecordDestinationOk(
          job.slot, job.record, FLAG_CLOUDFLARE_OK)) {
      Serial.println("Failed to update local Cloudflare acknowledgement flag.");
    }
    if (cloudflareOk) resetCloudflareBackoff();
    else {
      Serial.printf("Cloudflare upload failed; local record retained. Consecutive failures: %lu\n",
                    static_cast<unsigned long>(consecutiveCloudflareFailures));
      scheduleCloudflareBackoff();
    }
    recoverPendingCloudflareRecords();
  }
}

bool setupCloudflareTask() {
  cloudflareQueue = xQueueCreate(CLOUDFLARE_QUEUE_LENGTH, sizeof(CloudflareJob));
  if (!cloudflareQueue) {
    Serial.println("ERROR: Cloudflare queue creation failed.");
    return false;
  }
  BaseType_t result = xTaskCreatePinnedToCore(
    cloudflareTask, "Cloudflare", CLOUDFLARE_TASK_STACK,
    nullptr, 1, &cloudflareTaskHandle, 0);
  if (result != pdPASS) {
    Serial.println("ERROR: Cloudflare task creation failed.");
    vQueueDelete(cloudflareQueue);
    cloudflareQueue = nullptr;
    return false;
  }
  Serial.println("Cloud upload task started.");
  return true;
}

bool queueCloudflareUpload(const SensorRecord& record, uint32_t slot) {
  if (!cloudflareQueue) return false;
  CloudflareJob job{};
  job.record = record;
  job.slot = slot;
  if (xQueueSend(cloudflareQueue, &job, 0) == pdTRUE) return true;
  droppedUploadJobs++;
  Serial.printf("Cloud upload queue full; dropped upload job. Total dropped: %lu\n",
                static_cast<unsigned long>(droppedUploadJobs));
  return false;
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
  float waterTemperature = NAN;
  bool bme280Valid = sensors::readAir(temperature, humidity, pressure);
  bool waterTemperatureValid = sensors::readWater(waterTemperature);

  if (bme280Valid) {
    consecutiveBme280Failures = 0;
  } else {
    sensors::invalidateAir();
    if (consecutiveBme280Failures < UINT8_MAX) consecutiveBme280Failures++;
    Serial.printf("BME280 measurement failed (%u/%u).\n",
                  consecutiveBme280Failures, MAX_CONSECUTIVE_SENSOR_FAILURES);
    if (consecutiveBme280Failures >= MAX_CONSECUTIVE_SENSOR_FAILURES) {
      servicedDelay(1000);
      ESP.restart();
    }
  }

  if (waterTemperatureValid) {
    consecutiveWaterTemperatureFailures = 0;
  } else {
    if (consecutiveWaterTemperatureFailures < UINT32_MAX) {
      consecutiveWaterTemperatureFailures++;
    }
    Serial.printf("DS18B20 measurement failed (%lu consecutive); continuing with available data.\n",
                  static_cast<unsigned long>(consecutiveWaterTemperatureFailures));
  }

  if (!bme280Valid && !waterTemperatureValid) {
    Serial.println("No primary sensor data available; storage and cloud upload skipped.");
    return;
  }

  int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

  Serial.println("--------------------------------");
  Serial.printf("Time: %s\n", formatLocalTime(now).c_str());
  if (bme280Valid) {
    Serial.printf("Temperature: %.2f C\nHumidity: %.2f %%\nPressure: %.2f hPa\n",
                  temperature, humidity, pressure);
  }
  if (waterTemperatureValid) Serial.printf("Water temperature: %.2f C\n", waterTemperature);
  Serial.printf("RSSI: %d dBm\n", rssi);

  SensorRecord record{};
  record.timestamp = static_cast<uint32_t>(now);
  record.bootId = currentBootId;
  record.sequence = nextReadingSequence++;
  record.firmwareVersion = FIRMWARE_VERSION_CODE;
  record.resetReason = static_cast<uint8_t>(bootResetReason);
  record.temperature = temperature;
  record.humidity = humidity;
  record.pressure = pressure;
  record.waterTemperature = waterTemperature;
  record.rssi = static_cast<int8_t>(constrain(rssi, -127, 0));
  if (bme280Valid) record.flags |= FLAG_BME280_VALID;
  if (waterTemperatureValid) record.flags |= FLAG_WATER_VALID;

  bool localSaved = false;
  uint32_t writtenSlot = UINT32_MAX;
  if (ring_storage::ready() && isTimeValid(now)) {
    localSaved = ring_storage::appendRecord(record, writtenSlot);
    if (!localSaved) {
      Serial.println("Local record append failed.");
    }
  }

  if (!queueCloudflareUpload(record, localSaved ? writtenSlot : UINT32_MAX)) {
    if (takeMutex(stateMutex, portMAX_DELAY)) {
      if (consecutiveCloudflareFailures < UINT32_MAX) consecutiveCloudflareFailures++;
      giveMutex(stateMutex);
    }
  }
}

// ================= SETUP / LOOP =================
void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.printf("\nESP32 hydroponics logger v%s starting.\n", FIRMWARE_VERSION);
  currentBootId = makeBootId();
  bootResetReason = esp_reset_reason();
  char bootId[17];
  formatBootId(currentBootId, bootId, sizeof(bootId));
  Serial.printf("Boot ID: %s, reset reason: %s\n",
                bootId, resetReasonName(bootResetReason));

  stateMutex = xSemaphoreCreateMutex();
  if (!stateMutex) {
    Serial.println("FATAL: mutex creation failed; execution stopped.");
    while (true) delay(1000);
  }

  sensors::begin(servicedDelay);
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    requestTimeSync();
    setupOTA();
  }

  ring_storage::begin(serviceNetwork);
  Serial.printf("Cloudflare ingestion: %s\n",
                cloudflareConfigured() ? "configured" : "disabled (device token missing)");
  Serial.printf("Free heap before tasks: %u bytes\n", ESP.getFreeHeap());

  setupCloudflareTask();
  lastSampleMs = millis() - SAMPLE_INTERVAL_MS;
  Serial.println("Setup complete.");
}

void loop() {
  maintainWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainTimeSync();
    setupOTA();
  }

  serviceNetwork();

  if (millis() - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = millis();
    performMeasurementCycle();
  }

  delay(5);
}
