/*
  ESP32 + BME280 Hydroponics Environment Logger v8.3.0
  --------------------------------------------------
  Cloud-focused release. Physical sensor values are sent to ThingSpeak and
  Cloudflare in parallel. ArduinoOTA and the 14-day LittleFS sensor ring remain
  available, while the ESP-hosted dashboard and HTTP API stay removed to reduce
  firmware size and runtime memory use.

  Each ring record carries a stable boot/sequence identity, all available sensor
  telemetry and independent acknowledgement flags for ThingSpeak and Cloudflare.
  SwitchBot observation and control are owned by the Cloudflare Worker.
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
constexpr uint32_t THINGSPEAK_TASK_STACK = 8192;
constexpr uint8_t THINGSPEAK_BULK_BATCH_SIZE = 40;
constexpr uint32_t THINGSPEAK_MIN_WRITE_INTERVAL_MS = 16000UL;
constexpr uint32_t THINGSPEAK_BULK_HTTP_TIMEOUT_MS = 15000UL;
constexpr uint8_t CLOUDFLARE_BULK_BATCH_SIZE = 15;
constexpr uint32_t CLOUDFLARE_HTTP_TIMEOUT_MS = 15000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_INITIAL_MS = 30000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_MAX_MS = 30UL * 60UL * 1000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_JITTER_MS = 5000UL;
static_assert(CLOUDFLARE_BULK_BATCH_SIZE <= THINGSPEAK_BULK_BATCH_SIZE,
              "Shared recovery buffer is too small");

// Keep false for an existing installation. Setting true may erase LittleFS if
// mounting fails, so use it only once for a genuinely new/unformatted partition.
constexpr bool FORMAT_LITTLEFS_IF_MOUNT_FAILED = false;

// ================= 14-DAY RING BUFFER =================
constexpr uint32_t RECORDS_PER_DAY = 24UL * 60UL / 2UL;
constexpr uint32_t MAX_RECORDS = 14UL * RECORDS_PER_DAY;
constexpr const char* LOG_FILE_PATH = "/sensor_ring_v8.bin";
constexpr const char* ACK_FILE_PATH = "/sensor_ack_v1.bin";
constexpr const char* LEGACY_LOG_FILE_PATH = "/sensor_ring.bin";
constexpr const char* LEGACY_V2_LOG_FILE_PATH = "/sensor_ring_v2.bin";
constexpr const char* LEGACY_V3_LOG_FILE_PATH = "/sensor_ring_v3.bin";
constexpr const char* LEGACY_V4_LOG_FILE_PATH = "/sensor_ring_v4.bin";
constexpr const char* LEGACY_V5_LOG_FILE_PATH = "/sensor_ring_v5.bin";
constexpr const char* LEGACY_V6_LOG_FILE_PATH = "/sensor_ring_v6.bin";
constexpr const char* LEGACY_V7_LOG_FILE_PATH = "/sensor_ring_v7.bin";
constexpr const char* LEGACY_LIGHT_EVENT_FILE_PATH = "/light_events.bin";
constexpr uint32_t VALID_EPOCH_MIN = 1704067200UL;
constexpr const char* FIRMWARE_VERSION = "8.3.0";
constexpr uint32_t FIRMWARE_VERSION_CODE = (8UL << 16) | (3UL << 8);
constexpr size_t FILESYSTEM_SAFETY_MARGIN = 128UL * 1024UL;
constexpr size_t RING_INITIALIZE_CHUNK_BYTES = 512UL;

enum RecordFlags : uint8_t {
  FLAG_BME280_VALID   = 1 << 0,
  FLAG_WATER_VALID    = 1 << 1,
  FLAG_THINGSPEAK_OK  = 1 << 4,
  FLAG_CLOUDFLARE_OK  = 1 << 5
};

struct __attribute__((packed)) SensorRecord {
  uint32_t timestamp;
  uint64_t bootId;
  uint32_t sequence;
  uint32_t firmwareVersion;
  float temperature;
  float humidity;
  float pressure;
  float waterTemperature;
  int8_t rssi;
  uint8_t flags;
  uint8_t resetReason;
  uint8_t reserved;
};
static_assert(sizeof(SensorRecord) == 40, "SensorRecord must remain 40 bytes");

struct ThingSpeakJob {
  SensorRecord record;
  uint32_t slot;
};

struct StoredRecordRef {
  SensorRecord record;
  uint32_t slot;
};

constexpr size_t REQUIRED_LOG_BYTES = static_cast<size_t>(MAX_RECORDS) * sizeof(SensorRecord);
constexpr size_t REQUIRED_ACK_BYTES = static_cast<size_t>(MAX_RECORDS);
constexpr uint8_t DESTINATION_ACK_MASK = FLAG_THINGSPEAK_OK | FLAG_CLOUDFLARE_OK;

int32_t newestSlot = -1;

Adafruit_BME280 bme;
OneWire waterTemperatureBus(WATER_TEMPERATURE_PIN);
DallasTemperature waterTemperatureSensors(&waterTemperatureBus);
DeviceAddress waterTemperatureAddress{};
WiFiClient thingSpeakClient;
QueueHandle_t thingSpeakQueue = nullptr;
SemaphoreHandle_t fsMutex = nullptr;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t thingSpeakTaskHandle = nullptr;

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
uint8_t consecutiveBme280Failures = 0;
uint32_t consecutiveWaterTemperatureFailures = 0;
uint32_t droppedUploadJobs = 0;
uint32_t lastThingSpeakWriteMs = 0;
StoredRecordRef bulkUploadBatch[THINGSPEAK_BULK_BATCH_SIZE]{};
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

bool formatUtcTimeToBuffer(time_t value, char* buffer, size_t bufferSize) {
  if (bufferSize == 0 || !isTimeValid(value)) return false;
  struct tm utcTime{};
  gmtime_r(&value, &utcTime);
  return strftime(buffer, bufferSize, "%Y-%m-%dT%H:%M:%SZ", &utcTime) > 0;
}

const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}

uint64_t makeBootId() {
  uint64_t randomValue =
    (static_cast<uint64_t>(esp_random()) << 32) | esp_random();
  uint64_t value = randomValue ^ ESP.getEfuseMac();
  return value == 0 ? 1 : value;
}

void formatBootId(uint64_t bootId, char* buffer, size_t bufferSize) {
  snprintf(buffer, bufferSize, "%08lx%08lx",
           static_cast<unsigned long>(bootId >> 32),
           static_cast<unsigned long>(bootId & 0xFFFFFFFFULL));
}

void formatReadingId(const SensorRecord& record, char* buffer, size_t bufferSize) {
  char bootId[17];
  formatBootId(record.bootId, bootId, sizeof(bootId));
  snprintf(buffer, bufferSize, "%s:%lu", bootId,
           static_cast<unsigned long>(record.sequence));
}

void formatFirmwareVersion(uint32_t version, char* buffer, size_t bufferSize) {
  snprintf(buffer, bufferSize, "%lu.%lu.%lu",
           static_cast<unsigned long>((version >> 16) & 0xFFU),
           static_cast<unsigned long>((version >> 8) & 0xFFU),
           static_cast<unsigned long>(version & 0xFFU));
}

bool sameRecordIdentity(const SensorRecord& left, const SensorRecord& right) {
  return left.timestamp == right.timestamp &&
         left.bootId == right.bootId &&
         left.sequence == right.sequence;
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
  bool bme280Valid = (record.flags & FLAG_BME280_VALID) != 0;
  bool waterValid = (record.flags & FLAG_WATER_VALID) != 0;
  return record.timestamp >= VALID_EPOCH_MIN &&
         record.bootId != 0 &&
         record.firmwareVersion != 0 &&
         (bme280Valid || waterValid) &&
         (!bme280Valid || validBME280Data(
           record.temperature, record.humidity, record.pressure)) &&
         (!waterValid || validWaterTemperature(record.waterTemperature));
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
  Serial.println("Invalid DS18B20 water temperature; water field is unavailable.");
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

bool readDestinationAckAt(File& file, uint32_t slot, uint8_t& flags) {
  if (!file.seek(slot, SeekSet)) return false;
  int value = file.read();
  if (value < 0) return false;
  flags = static_cast<uint8_t>(value) & DESTINATION_ACK_MASK;
  return true;
}

bool writeDestinationAckAt(File& file, uint32_t slot, uint8_t flags) {
  if (!file.seek(slot, SeekSet)) return false;
  return file.write(flags & DESTINATION_ACK_MASK) == 1;
}

bool removeLegacyStorageFiles() {
  const char* paths[] = {
    LEGACY_LOG_FILE_PATH,
    LEGACY_V2_LOG_FILE_PATH,
    LEGACY_V3_LOG_FILE_PATH,
    LEGACY_V4_LOG_FILE_PATH,
    LEGACY_V5_LOG_FILE_PATH,
    LEGACY_V6_LOG_FILE_PATH,
    LEGACY_V7_LOG_FILE_PATH,
    LEGACY_LIGHT_EVENT_FILE_PATH
  };
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

  if (currentSize > 0 || LittleFS.exists(LOG_FILE_PATH)) {
    if (!LittleFS.remove(LOG_FILE_PATH)) {
      Serial.println("ERROR: Could not remove incomplete ring file.");
      return false;
    }
  }

  size_t usedBytes = LittleFS.usedBytes();
  size_t availableBytes = LittleFS.totalBytes() > usedBytes
    ? LittleFS.totalBytes() - usedBytes
    : 0;
  if (availableBytes < REQUIRED_LOG_BYTES + FILESYSTEM_SAFETY_MARGIN) {
    Serial.printf("ERROR: LittleFS free space is insufficient: %u bytes available.\n",
                  static_cast<unsigned>(availableBytes));
    return false;
  }

  Serial.printf("Creating sequential dual-destination ring file: %u bytes\n",
                static_cast<unsigned>(REQUIRED_LOG_BYTES));
  file = LittleFS.open(LOG_FILE_PATH, "w");
  if (!file) return false;

  static const uint8_t zeroBlock[RING_INITIALIZE_CHUNK_BYTES] = {};
  size_t bytesRemaining = REQUIRED_LOG_BYTES;
  size_t bytesWritten = 0;
  bool ok = true;
  while (bytesRemaining > 0) {
    size_t chunkSize = bytesRemaining < sizeof(zeroBlock)
      ? bytesRemaining
      : sizeof(zeroBlock);
    if (file.write(zeroBlock, chunkSize) != chunkSize) {
      ok = false;
      break;
    }
    bytesRemaining -= chunkSize;
    bytesWritten += chunkSize;
    if ((bytesWritten & 0x1FFFU) == 0) serviceNetwork();
  }

  if (ok) file.flush();
  file.close();
  if (!ok) {
    LittleFS.remove(LOG_FILE_PATH);
    Serial.printf("ERROR: Ring initialization stopped after %u bytes.\n",
                  static_cast<unsigned>(bytesWritten));
    return false;
  }

  file = LittleFS.open(LOG_FILE_PATH, "r");
  bool validSize = file && file.size() == REQUIRED_LOG_BYTES;
  if (file) file.close();
  if (!validSize) {
    LittleFS.remove(LOG_FILE_PATH);
    Serial.println("ERROR: Ring file size verification failed.");
    return false;
  }
  Serial.println("Sequential ring file created and verified.");
  return true;
}

bool ensureDestinationAckFile() {
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r");
  size_t currentSize = ackFile ? ackFile.size() : 0;
  if (ackFile) ackFile.close();
  if (currentSize == REQUIRED_ACK_BYTES) return true;

  if (currentSize > 0 || LittleFS.exists(ACK_FILE_PATH)) {
    if (!LittleFS.remove(ACK_FILE_PATH)) {
      Serial.println("ERROR: Could not remove incomplete destination ack file.");
      return false;
    }
  }

  File ringFile = LittleFS.open(LOG_FILE_PATH, "r");
  ackFile = LittleFS.open(ACK_FILE_PATH, "w");
  if (!ringFile || !ackFile) {
    if (ringFile) ringFile.close();
    if (ackFile) ackFile.close();
    LittleFS.remove(ACK_FILE_PATH);
    return false;
  }

  Serial.printf("Creating destination ack sidecar: %u bytes\n",
                static_cast<unsigned>(REQUIRED_ACK_BYTES));
  bool ok = true;
  for (uint32_t slot = 0; slot < MAX_RECORDS; ++slot) {
    SensorRecord record{};
    if (!readRecordAt(ringFile, slot, record)) {
      ok = false;
      break;
    }
    uint8_t ackFlags = validStoredRecord(record)
      ? record.flags & DESTINATION_ACK_MASK
      : 0;
    if (ackFile.write(ackFlags) != 1) {
      ok = false;
      break;
    }
    if ((slot & 0x3FFU) == 0) serviceNetwork();
  }
  if (ok) ackFile.flush();
  ringFile.close();
  ackFile.close();

  ackFile = LittleFS.open(ACK_FILE_PATH, "r");
  bool validSize = ok && ackFile && ackFile.size() == REQUIRED_ACK_BYTES;
  if (ackFile) ackFile.close();
  if (!validSize) {
    LittleFS.remove(ACK_FILE_PATH);
    Serial.println("ERROR: Destination ack sidecar initialization failed.");
    return false;
  }
  Serial.println("Destination ack sidecar created and verified.");
  return true;
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

  // v5/v6 exceeded LittleFS's safe copy-on-write budget. Their presence is a
  // one-time migration marker: format before creating the smaller v7 ring.
  if (LittleFS.exists(LEGACY_V5_LOG_FILE_PATH) ||
      LittleFS.exists(LEGACY_V6_LOG_FILE_PATH)) {
    Serial.println("Oversized legacy ring detected; reformatting LittleFS once.");
    LittleFS.end();
    filesystemMounted = false;
    if (!LittleFS.format() || !LittleFS.begin(false)) {
      Serial.println("ERROR: LittleFS migration format or remount failed.");
      return false;
    }
    filesystemMounted = true;
    Serial.println("LittleFS migration format completed.");
  }

  Serial.printf("Flash: %u bytes\n", ESP.getFlashChipSize());
  Serial.printf("LittleFS total: %u bytes\n", LittleFS.totalBytes());
  Serial.printf("LittleFS used: %u bytes\n", LittleFS.usedBytes());
  Serial.printf("Ring required: %u bytes\n", static_cast<unsigned>(REQUIRED_LOG_BYTES));
  Serial.printf("Ack sidecar required: %u bytes\n",
                static_cast<unsigned>(REQUIRED_ACK_BYTES));

  // Updating the beginning of a LittleFS file may temporarily require a second
  // copy of the file's data. Keep room for both copies plus filesystem metadata.
  size_t totalRequired = REQUIRED_LOG_BYTES * 2UL +
                         REQUIRED_ACK_BYTES * 2UL +
                         FILESYSTEM_SAFETY_MARGIN;
  if (LittleFS.totalBytes() < totalRequired) {
    Serial.println("ERROR: LittleFS partition is too small for safe ring overwrites.");
    return false;
  }

  if (!takeMutex(fsMutex, pdMS_TO_TICKS(2000))) {
    Serial.println("ERROR: Could not lock LittleFS during initialization.");
    return false;
  }
  bool ok = removeLegacyStorageFiles() &&
            ensureRingFile() &&
            ensureDestinationAckFile() &&
            scanRingFile();
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
  // Clear acknowledgements before replacing a slot. A power loss between these
  // writes can cause a harmless retry of the old record, but can never make a
  // new record inherit stale destination acknowledgements.
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r+");
  bool ackReset = ackFile && writeDestinationAckAt(ackFile, nextSlot, 0);
  if (ackFile) {
    if (ackReset) ackFile.flush();
    ackFile.close();
  }
  if (!ackReset) {
    giveMutex(fsMutex);
    return false;
  }

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

bool validDestinationFlag(uint8_t flag) {
  return flag == FLAG_THINGSPEAK_OK || flag == FLAG_CLOUDFLARE_OK;
}

bool markRecordDestinationOk(
    uint32_t slot,
    const SensorRecord& expected,
    uint8_t destinationFlag) {
  if (!filesystemReady || slot >= MAX_RECORDS ||
      !validDestinationFlag(destinationFlag)) return false;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(1000))) return false;

  File ringFile = LittleFS.open(LOG_FILE_PATH, "r");
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r+");
  if (!ringFile || !ackFile) {
    if (ringFile) ringFile.close();
    if (ackFile) ackFile.close();
    giveMutex(fsMutex);
    return false;
  }
  SensorRecord record{};
  uint8_t ackFlags = 0;
  bool ok = readRecordAt(ringFile, slot, record) &&
            readDestinationAckAt(ackFile, slot, ackFlags);
  if (ok && validStoredRecord(record) && sameRecordIdentity(record, expected)) {
    ok = writeDestinationAckAt(ackFile, slot, ackFlags | destinationFlag);
  } else {
    ok = false;
  }
  if (ok) ackFile.flush();
  ringFile.close();
  ackFile.close();
  giveMutex(fsMutex);
  return ok;
}

size_t collectPendingDestinationRecords(
    StoredRecordRef* records,
    size_t capacity,
    uint8_t destinationFlag) {
  if (!filesystemReady || records == nullptr || capacity == 0 ||
      !validDestinationFlag(destinationFlag)) return 0;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(2000))) return 0;

  File file = LittleFS.open(LOG_FILE_PATH, "r");
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r");
  if (!file || !ackFile) {
    if (file) file.close();
    if (ackFile) ackFile.close();
    giveMutex(fsMutex);
    return 0;
  }

  size_t count = 0;
  uint32_t startSlot = newestSlot < 0
    ? 0
    : (static_cast<uint32_t>(newestSlot) + 1UL) % MAX_RECORDS;
  for (uint32_t offset = 0; offset < MAX_RECORDS && count < capacity; ++offset) {
    uint32_t slot = (startSlot + offset) % MAX_RECORDS;
    SensorRecord record{};
    uint8_t ackFlags = 0;
    if (!readRecordAt(file, slot, record) ||
        !readDestinationAckAt(ackFile, slot, ackFlags)) break;
    if (validStoredRecord(record) && (ackFlags & destinationFlag) == 0) {
      records[count].record = record;
      records[count].slot = slot;
      count++;
    }
    if ((offset & 0x3FFU) == 0) yield();
  }

  file.close();
  ackFile.close();
  giveMutex(fsMutex);
  return count;
}

size_t markRecordsDestinationOk(
    const StoredRecordRef* records,
    size_t count,
    uint8_t destinationFlag) {
  if (!filesystemReady || records == nullptr || count == 0 ||
      !validDestinationFlag(destinationFlag)) return 0;
  if (!takeMutex(fsMutex, pdMS_TO_TICKS(2000))) return 0;

  File ringFile = LittleFS.open(LOG_FILE_PATH, "r");
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r+");
  if (!ringFile || !ackFile) {
    if (ringFile) ringFile.close();
    if (ackFile) ackFile.close();
    giveMutex(fsMutex);
    return 0;
  }

  size_t marked = 0;
  for (size_t index = 0; index < count; ++index) {
    SensorRecord stored{};
    uint8_t ackFlags = 0;
    bool matches = readRecordAt(ringFile, records[index].slot, stored) &&
                   readDestinationAckAt(ackFile, records[index].slot, ackFlags) &&
                   validStoredRecord(stored) &&
                   sameRecordIdentity(stored, records[index].record);
    if (!matches) continue;
    if (writeDestinationAckAt(
          ackFile, records[index].slot, ackFlags | destinationFlag)) marked++;
  }
  if (marked > 0) ackFile.flush();
  ringFile.close();
  ackFile.close();
  giveMutex(fsMutex);
  return marked;
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

void appendJsonNumberOrNull(String& payload, float value, bool valid, uint8_t digits = 3) {
  if (valid && isfinite(value)) {
    payload += String(value, static_cast<unsigned int>(digits));
  }
  else payload += F("null");
}

bool appendCloudflareReadingJson(String& payload, const SensorRecord& record) {
  if (!validStoredRecord(record)) return false;
  char measuredAt[25];
  if (!formatUtcTimeToBuffer(record.timestamp, measuredAt, sizeof(measuredAt))) return false;
  char bootId[17];
  char readingId[40];
  char firmwareVersion[16];
  formatBootId(record.bootId, bootId, sizeof(bootId));
  formatReadingId(record, readingId, sizeof(readingId));
  formatFirmwareVersion(record.firmwareVersion, firmwareVersion, sizeof(firmwareVersion));

  bool bmeValid = (record.flags & FLAG_BME280_VALID) != 0;
  bool waterValid = (record.flags & FLAG_WATER_VALID) != 0;
  bool rssiValid = record.rssi < 0;

  payload += F("{\"schema_version\":1,\"reading_id\":\"");
  payload += readingId;
  payload += F("\",\"boot_id\":\"");
  payload += bootId;
  payload += F("\",\"sequence\":");
  payload += String(record.sequence);
  payload += F(",\"measured_at\":\"");
  payload += measuredAt;
  payload += F("\",\"firmware_version\":\"");
  payload += firmwareVersion;
  payload += F("\",\"reset_reason\":\"");
  payload += resetReasonName(static_cast<esp_reset_reason_t>(record.resetReason));
  payload += F("\",\"values\":{\"air_temperature\":");
  appendJsonNumberOrNull(payload, record.temperature, bmeValid);
  payload += F(",\"humidity\":");
  appendJsonNumberOrNull(payload, record.humidity, bmeValid);
  payload += F(",\"pressure\":");
  appendJsonNumberOrNull(payload, record.pressure, bmeValid);
  payload += F(",\"wifi_rssi\":");
  if (rssiValid) payload += String(static_cast<int>(record.rssi));
  else payload += F("null");
  payload += F(",\"water_temperature\":");
  appendJsonNumberOrNull(payload, record.waterTemperature, waterValid);
  payload += F("}}");
  return true;
}

bool responseAcknowledgesReading(const String& response, const SensorRecord& record) {
  char readingId[40];
  formatReadingId(record, readingId, sizeof(readingId));
  String quotedReadingId = String('"') + readingId + '"';
  int readingPosition = response.indexOf(quotedReadingId);
  if (readingPosition < 0) return false;
  int statusPosition = response.indexOf(F("\"status\""), readingPosition + quotedReadingId.length());
  if (statusPosition < 0) return false;
  int nextReadingPosition = response.indexOf(F("\"reading_id\""), readingPosition + quotedReadingId.length());
  if (nextReadingPosition >= 0 && nextReadingPosition < statusPosition) return false;
  int colon = response.indexOf(':', statusPosition);
  int valueStart = colon >= 0 ? response.indexOf('"', colon + 1) : -1;
  int valueEnd = valueStart >= 0 ? response.indexOf('"', valueStart + 1) : -1;
  if (valueStart < 0 || valueEnd < 0) return false;
  String status = response.substring(valueStart + 1, valueEnd);
  return status == "accepted" || status == "duplicate";
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
  size_t count = collectPendingDestinationRecords(
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
  size_t marked = markRecordsDestinationOk(
    bulkUploadBatch, acknowledged, FLAG_CLOUDFLARE_OK);
  Serial.printf("Cloudflare recovery: %u acknowledged, %u marked complete.\n",
                static_cast<unsigned>(acknowledged), static_cast<unsigned>(marked));
  if (acknowledged == count && marked == acknowledged) resetCloudflareBackoff();
  else scheduleCloudflareBackoff();
}

// ================= CLOUD UPLOAD TASK =================
int uploadToThingSpeak(const ThingSpeakJob& job) {
  if (WiFi.status() != WL_CONNECTED) return -1000;
  int code = -1;
  for (uint8_t attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; ++attempt) {
    if ((job.record.flags & FLAG_BME280_VALID) != 0) {
      ThingSpeak.setField(1, job.record.temperature);
      ThingSpeak.setField(2, job.record.humidity);
      ThingSpeak.setField(3, job.record.pressure);
    }
    ThingSpeak.setField(4, static_cast<long>(job.record.rssi));
    if ((job.record.flags & FLAG_WATER_VALID) != 0) {
      ThingSpeak.setField(5, job.record.waterTemperature);
    }
    ThingSpeak.setStatus("Sensor online");
    code = ThingSpeak.writeFields(THINGSPEAK_CHANNEL_ID, THINGSPEAK_WRITE_API_KEY);
    lastThingSpeakWriteMs = millis();
    if (code == 200) {
      Serial.printf("ThingSpeak upload succeeded on attempt %u.\n", attempt);
      return code;
    }
    Serial.printf("ThingSpeak attempt %u failed: %d\n", attempt, code);
    if (attempt < MAX_UPLOAD_ATTEMPTS) vTaskDelay(pdMS_TO_TICKS(UPLOAD_RETRY_DELAY_MS));
  }
  return code;
}

bool waitForThingSpeakWriteWindow() {
  while (lastThingSpeakWriteMs != 0 &&
         millis() - lastThingSpeakWriteMs < THINGSPEAK_MIN_WRITE_INTERVAL_MS) {
    if (WiFi.status() != WL_CONNECTED || otaInProgress) return false;
    vTaskDelay(pdMS_TO_TICKS(100));
  }
  return WiFi.status() == WL_CONNECTED && !otaInProgress;
}

bool appendBulkRecordJson(String& payload, const SensorRecord& record, bool first) {
  if (!validStoredRecord(record)) return false;
  if (!first) payload += ',';
  payload += F("{\"created_at\":\"");
  payload += String(record.timestamp);
  payload += '"';
  if ((record.flags & FLAG_BME280_VALID) != 0) {
    payload += F(",\"field1\":");
    payload += String(record.temperature, 3);
    payload += F(",\"field2\":");
    payload += String(record.humidity, 3);
    payload += F(",\"field3\":");
    payload += String(record.pressure, 3);
  }
  if (record.rssi < 0) {
    payload += F(",\"field4\":");
    payload += String(static_cast<int>(record.rssi));
  }
  if ((record.flags & FLAG_WATER_VALID) != 0) {
    payload += F(",\"field5\":");
    payload += String(record.waterTemperature, 3);
  }
  payload += '}';
  return true;
}

int bulkUploadToThingSpeak(const StoredRecordRef* records, size_t count) {
  if (WiFi.status() != WL_CONNECTED || records == nullptr || count == 0) return -1000;
  if (!waitForThingSpeakWriteWindow()) return -1001;

  String payload;
  if (!payload.reserve(96 + count * 150U)) {
    Serial.println("ThingSpeak bulk upload skipped: insufficient heap for JSON payload.");
    return -1002;
  }
  payload += F("{\"write_api_key\":\"");
  payload += THINGSPEAK_WRITE_API_KEY;
  payload += F("\",\"updates\":[");
  size_t appended = 0;
  for (size_t index = 0; index < count; ++index) {
    if (appendBulkRecordJson(payload, records[index].record, appended == 0)) appended++;
  }
  payload += F("]}");
  if (appended == 0) return -1003;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String("https://api.thingspeak.com/channels/") +
               String(THINGSPEAK_CHANNEL_ID) + "/bulk_update.json";
  if (!http.begin(client, url)) {
    Serial.println("ThingSpeak bulk HTTP begin failed.");
    return -1004;
  }
  http.setTimeout(THINGSPEAK_BULK_HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(reinterpret_cast<uint8_t*>(payload.begin()), payload.length());
  lastThingSpeakWriteMs = millis();
  String response = code > 0 ? http.getString() : String();
  http.end();
  response.replace(" ", "");
  response.replace("\r", "");
  response.replace("\n", "");
  if (code == 200 && response.indexOf("\"success\":true") >= 0) return code;

  Serial.printf("ThingSpeak bulk upload failed: HTTP %d.\n", code);
  return code == 200 ? -1005 : code;
}

void recoverPendingThingSpeakRecords() {
  size_t count = collectPendingDestinationRecords(
    bulkUploadBatch, THINGSPEAK_BULK_BATCH_SIZE, FLAG_THINGSPEAK_OK);
  if (count == 0) return;

  Serial.printf("ThingSpeak recovery: uploading %u stored records.\n",
                static_cast<unsigned>(count));
  int code = bulkUploadToThingSpeak(bulkUploadBatch, count);
  if (code != 200) {
    Serial.println("ThingSpeak recovery deferred; stored records remain pending.");
    return;
  }

  size_t marked = markRecordsDestinationOk(
    bulkUploadBatch, count, FLAG_THINGSPEAK_OK);
  Serial.printf("ThingSpeak recovery succeeded: %u uploaded, %u marked complete.\n",
                static_cast<unsigned>(count), static_cast<unsigned>(marked));
  if (marked != count) {
    Serial.println("Some recovered slots changed before confirmation; they will be checked again.");
  }
}

void thingSpeakTask(void* parameter) {
  ThingSpeakJob job{};
  for (;;) {
    if (xQueueReceive(thingSpeakQueue, &job, portMAX_DELAY) != pdTRUE) continue;
    while (otaInProgress) vTaskDelay(pdMS_TO_TICKS(100));
    int code = uploadToThingSpeak(job);
    bool thingSpeakOk = code == 200;
    bool cloudflareEnabled = cloudflareConfigured();
    bool cloudflareOk = cloudflareEnabled && uploadToCloudflare(job.record);

    if (takeMutex(stateMutex, portMAX_DELAY)) {
      if (thingSpeakOk) consecutiveUploadFailures = 0;
      else if (consecutiveUploadFailures < UINT32_MAX) consecutiveUploadFailures++;
      if (cloudflareEnabled) {
        if (cloudflareOk) consecutiveCloudflareFailures = 0;
        else if (consecutiveCloudflareFailures < UINT32_MAX) consecutiveCloudflareFailures++;
      }
      giveMutex(stateMutex);
    }

    if (thingSpeakOk && job.slot < MAX_RECORDS &&
        !markRecordDestinationOk(job.slot, job.record, FLAG_THINGSPEAK_OK)) {
      Serial.println("Failed to update local ThingSpeak acknowledgement flag.");
    }
    if (cloudflareOk && job.slot < MAX_RECORDS &&
        !markRecordDestinationOk(job.slot, job.record, FLAG_CLOUDFLARE_OK)) {
      Serial.println("Failed to update local Cloudflare acknowledgement flag.");
    }
    if (!thingSpeakOk) {
      Serial.printf("ThingSpeak upload failed; local record retained. Consecutive failures: %lu\n",
                    static_cast<unsigned long>(consecutiveUploadFailures));
    } else {
      recoverPendingThingSpeakRecords();
    }
    if (cloudflareEnabled) {
      if (cloudflareOk) resetCloudflareBackoff();
      else {
        Serial.printf("Cloudflare upload failed; local record retained. Consecutive failures: %lu\n",
                      static_cast<unsigned long>(consecutiveCloudflareFailures));
        scheduleCloudflareBackoff();
      }
      recoverPendingCloudflareRecords();
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
  Serial.println("Cloud upload task started.");
  return true;
}

bool queueThingSpeakUpload(const SensorRecord& record, uint32_t slot) {
  if (!thingSpeakQueue) return false;
  ThingSpeakJob job{};
  job.record = record;
  job.slot = slot;
  if (xQueueSend(thingSpeakQueue, &job, 0) == pdTRUE) return true;
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
  bool bme280Valid = readBME280(temperature, humidity, pressure);
  bool waterTemperatureValid = readWaterTemperature(waterTemperature);

  if (bme280Valid) {
    consecutiveBme280Failures = 0;
  } else {
    bmeAddress = 0;
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
  if (filesystemReady && isTimeValid(now)) {
    localSaved = appendRecord(record, writtenSlot);
    if (!localSaved) {
      Serial.println("Local record append failed.");
    }
  }

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
  Serial.printf("\nESP32 hydroponics logger v%s starting.\n", FIRMWARE_VERSION);
  currentBootId = makeBootId();
  bootResetReason = esp_reset_reason();
  char bootId[17];
  formatBootId(currentBootId, bootId, sizeof(bootId));
  Serial.printf("Boot ID: %s, reset reason: %s\n",
                bootId, resetReasonName(bootResetReason));

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
  Serial.printf("Cloudflare ingestion: %s\n",
                cloudflareConfigured() ? "configured" : "disabled (device token missing)");
  Serial.printf("Free heap before tasks: %u bytes\n", ESP.getFreeHeap());

  setupThingSpeakTask();
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
