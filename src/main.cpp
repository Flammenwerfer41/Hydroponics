/*
  ESP32 + BME280 Hydroponics Environment Logger v8.0
  --------------------------------------------------
  Cloud-focused release. Sensor and SwitchBot values are sent to ThingSpeak for
  the public GitHub Pages dashboard. ArduinoOTA and the existing 30-day LittleFS
  sensor ring remain available, while the ESP-hosted dashboard and HTTP API have
  been removed to reduce firmware size and runtime memory use.

  Water temperature is a required measurement and is stored with the BME280 data
  in a new 24-byte ring record. Legacy local files are removed during migration.
*/

#include <Arduino.h>
#include "secrets.h"
#include <Wire.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <LittleFS.h>
#include <FS.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>
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
constexpr int WATER_TEMPERATURE_PIN = 21;
constexpr uint8_t DS18B20_RESOLUTION_BITS = 11;
constexpr uint32_t DS18B20_CONVERSION_MS = 375UL;
constexpr uint32_t SAMPLE_INTERVAL_MS = 120000UL;
constexpr uint8_t MAX_UPLOAD_ATTEMPTS = 1;
constexpr uint32_t UPLOAD_RETRY_DELAY_MS = 0UL;
constexpr uint8_t MAX_CONSECUTIVE_SENSOR_FAILURES = 5;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000UL;
constexpr uint32_t NTP_RETRY_INTERVAL_MS = 300000UL;
constexpr uint32_t OTA_RECEIVE_TIMEOUT_MS = 8000UL;
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
constexpr const char* LOG_FILE_PATH = "/sensor_ring_v2.bin";
constexpr const char* LEGACY_LOG_FILE_PATH = "/sensor_ring.bin";
constexpr const char* LEGACY_LIGHT_EVENT_FILE_PATH = "/light_events.bin";
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
  float waterTemperature;
  int8_t rssi;
  uint8_t flags;
  uint16_t reserved;
};
static_assert(sizeof(SensorRecord) == 24, "SensorRecord must remain 24 bytes");

struct ThingSpeakJob {
  SensorRecord record;
  uint32_t slot;
  bool lightTelemetryValid;
  bool lightOn;
  float lightPower;
  uint32_t lightMinutesToday;
};

struct SwitchBotJob {
  uint32_t sampleTimestamp;
};

constexpr size_t REQUIRED_LOG_BYTES = static_cast<size_t>(MAX_RECORDS) * sizeof(SensorRecord);

int32_t newestSlot = -1;

Adafruit_BME280 bme;
OneWire waterTemperatureBus(WATER_TEMPERATURE_PIN);
DallasTemperature waterTemperatureSensors(&waterTemperatureBus);
DeviceAddress waterTemperatureAddress{};
WiFiClient thingSpeakClient;
QueueHandle_t thingSpeakQueue = nullptr;
QueueHandle_t switchBotQueue = nullptr;
SemaphoreHandle_t fsMutex = nullptr;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t thingSpeakTaskHandle = nullptr;
TaskHandle_t switchBotTaskHandle = nullptr;

uint8_t bmeAddress = 0;
bool waterTemperatureSensorReady = false;
bool filesystemMounted = false;
bool filesystemReady = false;
bool timeReady = false;
bool otaReady = false;
volatile bool otaInProgress = false;
wifi_ps_type_t otaPreviousSleepMode = WIFI_PS_MIN_MODEM;
bool previousWiFiConnected = false;

uint32_t lastSampleMs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastNtpRequestMs = 0;
bool ntpRequestActive = false;
uint32_t consecutiveUploadFailures = 0;
uint8_t consecutiveSensorFailures = 0;
uint32_t droppedUploadJobs = 0;
bool latestLightStateKnown = false;
bool latestLightOn = false;
float latestLightPower = NAN;
uint32_t latestLightMinutesToday = 0;
int latestSwitchBotHttpCode = 0;
int latestSwitchBotStatusCode = 0;

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

bool validBME280Data(float temperature, float humidity, float pressure) {
  return isfinite(temperature) && isfinite(humidity) && isfinite(pressure) &&
         temperature >= -40.0f && temperature <= 85.0f &&
         humidity >= 0.0f && humidity <= 100.0f &&
         pressure >= 300.0f && pressure <= 1100.0f;
}

bool validWaterTemperature(float temperature) {
  return isfinite(temperature) &&
         temperature != DEVICE_DISCONNECTED_C &&
         temperature != 85.0f &&
         temperature >= -55.0f && temperature <= 125.0f;
}

bool validStoredRecord(const SensorRecord& record) {
  return record.timestamp >= VALID_EPOCH_MIN &&
         (record.flags & FLAG_SENSOR_VALID) != 0 &&
         validBME280Data(record.temperature, record.humidity, record.pressure) &&
         validWaterTemperature(record.waterTemperature);
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
  return validBME280Data(temperature, humidity, pressure);
}

// ================= DS18B20 WATER TEMPERATURE =================
bool initializeDS18B20() {
  waterTemperatureSensors.begin();
  if (!waterTemperatureSensors.getAddress(waterTemperatureAddress, 0)) {
    waterTemperatureSensorReady = false;
    Serial.printf("DS18B20 not found on GPIO %d.\n", WATER_TEMPERATURE_PIN);
    return false;
  }
  waterTemperatureSensors.setResolution(
    waterTemperatureAddress, DS18B20_RESOLUTION_BITS);
  waterTemperatureSensors.setWaitForConversion(false);
  waterTemperatureSensorReady = true;
  Serial.printf("DS18B20 ready on GPIO %d at %u-bit resolution.\n",
                WATER_TEMPERATURE_PIN, DS18B20_RESOLUTION_BITS);
  return true;
}

bool readWaterTemperature(float& temperature) {
  temperature = NAN;
  if (!waterTemperatureSensorReady && !initializeDS18B20()) return false;
  waterTemperatureSensors.requestTemperaturesByAddress(waterTemperatureAddress);
  servicedDelay(DS18B20_CONVERSION_MS);
  temperature = waterTemperatureSensors.getTempC(waterTemperatureAddress);
  if (validWaterTemperature(temperature)) return true;
  waterTemperatureSensorReady = false;
  temperature = NAN;
  Serial.println("Invalid DS18B20 water temperature; measurement cycle will be skipped.");
  return false;
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

bool removeLegacyStorageFiles() {
  const char* paths[] = {LEGACY_LOG_FILE_PATH, LEGACY_LIGHT_EVENT_FILE_PATH};
  for (const char* path : paths) {
    if (!LittleFS.exists(path)) continue;
    if (!LittleFS.remove(path)) {
      Serial.printf("ERROR: Could not remove legacy storage file %s.\n", path);
      return false;
    }
    Serial.printf("Removed legacy storage file %s.\n", path);
  }
  return true;
}

bool ensureRingFile() {
  if (!filesystemMounted) return false;
  File file = LittleFS.open(LOG_FILE_PATH, "r");
  size_t currentSize = file ? file.size() : 0;
  if (file) file.close();
  if (currentSize == REQUIRED_LOG_BYTES) return true;

  Serial.printf("Creating water-aware ring file: %u bytes\n",
                static_cast<unsigned>(REQUIRED_LOG_BYTES));
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

bool scanRingFile() {
  newestSlot = -1;

  File file = LittleFS.open(LOG_FILE_PATH, "r");
  if (!file) return false;

  uint32_t newestTimestamp = 0;
  uint32_t validRecordCount = 0;
  uint32_t invalidRecordCount = 0;
  for (uint32_t slot = 0; slot < MAX_RECORDS; ++slot) {
    SensorRecord record{};
    if (!readRecordAt(file, slot, record)) {
      file.close();
      return false;
    }
    if (validStoredRecord(record)) {
      validRecordCount++;
      if (record.timestamp >= newestTimestamp) {
        newestTimestamp = record.timestamp;
        newestSlot = static_cast<int32_t>(slot);
      }
    } else if (record.timestamp != 0 || record.flags != 0) {
      invalidRecordCount++;
    }
    if ((slot & 0x3FFU) == 0) yield();
  }
  file.close();

  Serial.printf("Ring scan: %u valid, %u invalid, newest slot %ld\n",
                validRecordCount, invalidRecordCount, static_cast<long>(newestSlot));
  return true;
}


bool initializeFilesystem() {
  filesystemMounted = false;
  filesystemReady = false;

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
  size_t totalRequired = REQUIRED_LOG_BYTES + SAFETY_MARGIN;
  if (LittleFS.totalBytes() < totalRequired) {
    Serial.println("ERROR: LittleFS partition is too small for the configured history.");
    return false;
  }

  if (!takeMutex(fsMutex, pdMS_TO_TICKS(2000))) {
    Serial.println("ERROR: Could not lock LittleFS during initialization.");
    return false;
  }
  bool ok = removeLegacyStorageFiles() && ensureRingFile() && scanRingFile();
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
  bool ok = readRecordAt(file, nextSlot, previous) &&
            writeRecordAt(file, nextSlot, record);
  file.flush();
  file.close();

  if (ok) {
    newestSlot = static_cast<int32_t>(nextSlot);
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

// ================= THINGSPEAK TASK =================
int uploadToThingSpeak(const ThingSpeakJob& job) {
  if (WiFi.status() != WL_CONNECTED) return -1000;
  int code = -1;
  for (uint8_t attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; ++attempt) {
    ThingSpeak.setField(1, job.record.temperature);
    ThingSpeak.setField(2, job.record.humidity);
    ThingSpeak.setField(3, job.record.pressure);
    ThingSpeak.setField(4, static_cast<long>(job.record.rssi));
    ThingSpeak.setField(5, job.record.waterTemperature);
    if (job.lightTelemetryValid) {
      ThingSpeak.setField(6, job.lightOn ? 1 : 0);
      ThingSpeak.setField(7, job.lightPower);
      ThingSpeak.setField(8, static_cast<long>(job.lightMinutesToday));
    }
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
  ThingSpeakJob job{};
  for (;;) {
    if (xQueueReceive(thingSpeakQueue, &job, portMAX_DELAY) != pdTRUE) continue;
    while (otaInProgress) vTaskDelay(pdMS_TO_TICKS(100));
    int code = uploadToThingSpeak(job);
    bool cloudOk = code == 200;

    if (takeMutex(stateMutex, portMAX_DELAY)) {
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
  if (takeMutex(stateMutex, portMAX_DELAY)) {
    job.lightTelemetryValid =
      latestLightStateKnown &&
      latestSwitchBotHttpCode == 200 &&
      latestSwitchBotStatusCode == 100 &&
      isfinite(latestLightPower);
    if (job.lightTelemetryValid) {
      job.lightOn = latestLightOn;
      job.lightPower = latestLightPower;
      job.lightMinutesToday = latestLightMinutesToday;
    }
    giveMutex(stateMutex);
  }
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
    latestLightPower = static_cast<float>(power);
    latestLightMinutesToday = runtimeMinutes;
    latestSwitchBotHttpCode = httpCode;
    latestSwitchBotStatusCode = static_cast<int>(apiStatus);
    giveMutex(stateMutex);
  }

  Serial.printf("SwitchBot: %s, %.1f W, %.1f V, %.3f A, %u min today\n",
                on ? "ON" : "OFF", power, voltage, currentMilliamps / 1000.0,
                static_cast<unsigned>(runtimeMinutes));
  return true;
}

void switchBotTask(void* parameter) {
  SwitchBotJob job{};
  for (;;) {
    if (xQueueReceive(switchBotQueue, &job, portMAX_DELAY) == pdTRUE) {
      while (otaInProgress) vTaskDelay(pdMS_TO_TICKS(100));
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
  bool bme280Valid = readBME280(temperature, humidity, pressure);
  bool waterTemperatureValid = readWaterTemperature(waterTemperature);
  if (!bme280Valid || !waterTemperatureValid) {
    consecutiveSensorFailures++;
    if (!bme280Valid) bmeAddress = 0;
    Serial.printf("Measurement failed: BME280=%s, DS18B20=%s (%u/%u).\n",
                  bme280Valid ? "ok" : "failed",
                  waterTemperatureValid ? "ok" : "failed",
                  consecutiveSensorFailures, MAX_CONSECUTIVE_SENSOR_FAILURES);
    if (consecutiveSensorFailures >= MAX_CONSECUTIVE_SENSOR_FAILURES) {
      servicedDelay(1000);
      ESP.restart();
    }
    return;
  }
  consecutiveSensorFailures = 0;

  int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

  Serial.println("--------------------------------");
  Serial.printf("Time: %s\n", formatLocalTime(now).c_str());
  Serial.printf("Temperature: %.2f C\nHumidity: %.2f %%\nPressure: %.2f hPa\nRSSI: %d dBm\n",
                temperature, humidity, pressure, rssi);
  Serial.printf("Water temperature: %.2f C\n", waterTemperature);

  SensorRecord record{};
  record.timestamp = static_cast<uint32_t>(now);
  record.temperature = temperature;
  record.humidity = humidity;
  record.pressure = pressure;
  record.waterTemperature = waterTemperature;
  record.rssi = static_cast<int8_t>(constrain(rssi, -127, 0));
  record.flags = FLAG_SENSOR_VALID;

  bool localSaved = false;
  uint32_t writtenSlot = UINT32_MAX;
  if (filesystemReady && isTimeValid(now)) {
    localSaved = appendRecord(record, writtenSlot);
    if (!localSaved) {
      Serial.println("Local record append failed.");
    }
  }

  if (isTimeValid(now)) queueSwitchBotQuery(static_cast<uint32_t>(now));
  if (!queueThingSpeakUpload(record, localSaved ? writtenSlot : UINT32_MAX)) {
    if (takeMutex(stateMutex, portMAX_DELAY)) {
      if (consecutiveUploadFailures < UINT32_MAX) consecutiveUploadFailures++;
      giveMutex(stateMutex);
    }
  }
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

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  initializeBME280();
  initializeDS18B20();
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    requestTimeSync();
    setupOTA();
  }

  thingSpeakClient.setTimeout(3000);
  ThingSpeak.begin(thingSpeakClient);

  initializeFilesystem();
  Serial.printf("Free heap before tasks: %u bytes\n", ESP.getFreeHeap());

  setupThingSpeakTask();
  setupSwitchBotTask();
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
