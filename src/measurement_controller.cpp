#include "measurement_controller.h"

#include <Arduino.h>
#include <esp_system.h>
#include <math.h>

#include "cloud_upload.h"
#include "firmware_config.h"
#include "network_manager.h"
#include "record_codec.h"
#include "ring_storage.h"
#include "sensor_manager.h"
#include "telemetry_record.h"

namespace measurement_controller {
namespace {

uint32_t lastSampleMs = 0;
uint8_t consecutiveBme280Failures = 0;
uint32_t consecutiveWaterTemperatureFailures = 0;
uint64_t currentBootId = 0;
uint32_t nextReadingSequence = 0;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

uint64_t makeBootId() {
  const uint64_t randomValue =
    (static_cast<uint64_t>(esp_random()) << 32) | esp_random();
  const uint64_t value = randomValue ^ ESP.getEfuseMac();
  return value == 0 ? 1 : value;
}

void performMeasurementCycle() {
  time_t now;
  network_manager::refreshCurrentTime(now);

  float temperature = NAN;
  float humidity = NAN;
  float pressure = NAN;
  float waterTemperature = NAN;
  const bool bme280Valid = sensors::readAir(temperature, humidity, pressure);
  const bool waterTemperatureValid = sensors::readWater(waterTemperature);

  if (bme280Valid) {
    consecutiveBme280Failures = 0;
  } else {
    sensors::invalidateAir();
    if (consecutiveBme280Failures < UINT8_MAX) {
      consecutiveBme280Failures++;
    }
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
    Serial.printf(
      "DS18B20 measurement failed (%lu consecutive); continuing with available data.\n",
      static_cast<unsigned long>(consecutiveWaterTemperatureFailures));
  }

  if (!bme280Valid && !waterTemperatureValid) {
    Serial.println(
      "No primary sensor data available; storage and cloud upload skipped.");
    return;
  }

  const int rssi = network_manager::rssi();

  Serial.println("--------------------------------");
  Serial.printf("Time: %s\n", network_manager::formatLocalTime(now).c_str());
  if (bme280Valid) {
    Serial.printf(
      "Temperature: %.2f C\nHumidity: %.2f %%\nPressure: %.2f hPa\n",
      temperature, humidity, pressure);
  }
  if (waterTemperatureValid) {
    Serial.printf("Water temperature: %.2f C\n", waterTemperature);
  }
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
  if (bme280Valid) {
    record.flags |= FLAG_BME280_VALID;
  }
  if (waterTemperatureValid) {
    record.flags |= FLAG_WATER_VALID;
  }

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

}  // namespace

void begin() {
  Serial.printf("\nESP32 hydroponics logger v%s starting.\n",
                firmware_config::FIRMWARE_VERSION);
  currentBootId = makeBootId();
  bootResetReason = esp_reset_reason();

  char bootId[17];
  formatBootId(currentBootId, bootId, sizeof(bootId));
  Serial.printf("Boot ID: %s, reset reason: %s\n",
                bootId, resetReasonName(bootResetReason));

  lastSampleMs = millis() - firmware_config::SAMPLE_INTERVAL_MS;
}

void maintain() {
  if (millis() - lastSampleMs < firmware_config::SAMPLE_INTERVAL_MS) {
    return;
  }

  lastSampleMs = millis();
  performMeasurementCycle();
}

}  // namespace measurement_controller
