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
#include "cloud_upload.h"
#include "firmware_config.h"
#include "record_codec.h"
#include "ring_storage.h"
#include "sensor_manager.h"
#include "telemetry_record.h"
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <time.h>
#include <math.h>

#ifndef CLOUDFLARE_INGEST_URL
#define CLOUDFLARE_INGEST_URL \
  "https://hydroponics-jma-weather.flammenwerfer41.workers.dev/v1/readings"
#endif

#ifndef CLOUDFLARE_DEVICE_TOKEN
#define CLOUDFLARE_DEVICE_TOKEN ""
#endif

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
uint64_t currentBootId = 0;
uint32_t nextReadingSequence = 0;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

bool isTimeValid(time_t value) {
  return value >= static_cast<time_t>(firmware_config::VALID_EPOCH_MIN) &&
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

bool cloudUploadPaused() {
  return otaInProgress;
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

  if (millis() - lastWiFiAttemptMs <
      firmware_config::WIFI_RECONNECT_INTERVAL_MS) return;
  lastWiFiAttemptMs = millis();
  Serial.println("Wi-Fi reconnecting.");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void requestTimeSync() {
  if (WiFi.status() != WL_CONNECTED) return;
  configTzTime(
    firmware_config::TIMEZONE,
    "pool.ntp.org",
    "time.google.com",
    "time.nist.gov");
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
  if (!ntpRequestActive ||
      millis() - lastNtpRequestMs >= firmware_config::NTP_RETRY_INTERVAL_MS) {
    requestTimeSync();
  }
}

void setupOTA() {
  if (otaReady) return;
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.setTimeout(firmware_config::OTA_RECEIVE_TIMEOUT_MS);
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
                  consecutiveBme280Failures,
                  firmware_config::MAX_CONSECUTIVE_AIR_SENSOR_FAILURES);
    if (consecutiveBme280Failures >=
        firmware_config::MAX_CONSECUTIVE_AIR_SENSOR_FAILURES) {
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
  record.firmwareVersion = firmware_config::FIRMWARE_VERSION_CODE;
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

  cloud_upload::enqueue(record, localSaved ? writtenSlot : UINT32_MAX);
}

// ================= SETUP / LOOP =================
void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.printf("\nESP32 hydroponics logger v%s starting.\n",
                firmware_config::FIRMWARE_VERSION);
  currentBootId = makeBootId();
  bootResetReason = esp_reset_reason();
  char bootId[17];
  formatBootId(currentBootId, bootId, sizeof(bootId));
  Serial.printf("Boot ID: %s, reset reason: %s\n",
                bootId, resetReasonName(bootResetReason));

  sensors::begin(servicedDelay);
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    requestTimeSync();
    setupOTA();
  }

  ring_storage::begin(serviceNetwork);
  cloud_upload::configure(CLOUDFLARE_INGEST_URL, CLOUDFLARE_DEVICE_TOKEN);
  Serial.printf("Cloudflare ingestion: %s\n",
                cloud_upload::configured()
                  ? "configured"
                  : "disabled (device token missing)");
  Serial.printf("Free heap before tasks: %u bytes\n", ESP.getFreeHeap());

  cloud_upload::begin(cloudUploadPaused);
  lastSampleMs = millis() - firmware_config::SAMPLE_INTERVAL_MS;
  Serial.println("Setup complete.");
}

void loop() {
  maintainWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainTimeSync();
    setupOTA();
  }

  serviceNetwork();

  if (millis() - lastSampleMs >= firmware_config::SAMPLE_INTERVAL_MS) {
    lastSampleMs = millis();
    performMeasurementCycle();
  }

  delay(5);
}
