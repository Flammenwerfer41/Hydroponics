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
#include "network_manager.h"
#include "record_codec.h"
#include "ring_storage.h"
#include "sensor_manager.h"
#include "telemetry_record.h"
#include <math.h>

#ifndef CLOUDFLARE_INGEST_URL
#define CLOUDFLARE_INGEST_URL \
  "https://hydroponics-jma-weather.flammenwerfer41.workers.dev/v1/readings"
#endif

#ifndef CLOUDFLARE_DEVICE_TOKEN
#define CLOUDFLARE_DEVICE_TOKEN ""
#endif

uint32_t lastSampleMs = 0;
uint8_t consecutiveBme280Failures = 0;
uint32_t consecutiveWaterTemperatureFailures = 0;
uint64_t currentBootId = 0;
uint32_t nextReadingSequence = 0;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

uint64_t makeBootId() {
  uint64_t randomValue =
    (static_cast<uint64_t>(esp_random()) << 32) | esp_random();
  uint64_t value = randomValue ^ ESP.getEfuseMac();
  return value == 0 ? 1 : value;
}
// ================= MEASUREMENT =================
void performMeasurementCycle() {
  time_t now;
  network_manager::refreshCurrentTime(now);

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
      network_manager::servicedDelay(1000);
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

  int rssi = network_manager::rssi();

  Serial.println("--------------------------------");
  Serial.printf("Time: %s\n", network_manager::formatLocalTime(now).c_str());
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
  if (ring_storage::ready() && network_manager::isTimeValid(now)) {
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

  sensors::begin(network_manager::servicedDelay);
  network_manager::begin({
    WIFI_SSID,
    WIFI_PASSWORD,
    OTA_HOSTNAME,
    OTA_PASSWORD
  });

  ring_storage::begin(network_manager::service);
  cloud_upload::configure(CLOUDFLARE_INGEST_URL, CLOUDFLARE_DEVICE_TOKEN);
  Serial.printf("Cloudflare ingestion: %s\n",
                cloud_upload::configured()
                  ? "configured"
                  : "disabled (device token missing)");
  Serial.printf("Free heap before tasks: %u bytes\n", ESP.getFreeHeap());

  cloud_upload::begin(network_manager::otaInProgress);
  lastSampleMs = millis() - firmware_config::SAMPLE_INTERVAL_MS;
  Serial.println("Setup complete.");
}

void loop() {
  network_manager::maintain();
  network_manager::service();

  if (millis() - lastSampleMs >= firmware_config::SAMPLE_INTERVAL_MS) {
    lastSampleMs = millis();
    performMeasurementCycle();
  }

  delay(5);
}
