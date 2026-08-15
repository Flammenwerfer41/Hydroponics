#pragma once

#include <Arduino.h>
#include <math.h>

enum RecordFlags : uint8_t {
  FLAG_BME280_VALID = 1 << 0,
  FLAG_WATER_VALID = 1 << 1,
  FLAG_SCD40_VALID = 1 << 2,
  FLAG_VEML7700_VALID = 1 << 3,
  // Bit 4 is retained in the on-flash record layout for v8 compatibility.
  FLAG_LEGACY_DESTINATION_OK = 1 << 4,
  FLAG_CLOUDFLARE_OK = 1 << 5
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
  float illuminance;
  uint16_t co2Concentration;
  int8_t rssi;
  uint8_t flags;
  uint8_t resetReason;
  uint8_t reserved;
  uint16_t reserved2;
};
static_assert(sizeof(SensorRecord) == 48, "SensorRecord must remain 48 bytes");

struct StoredRecordRef {
  SensorRecord record;
  uint32_t slot;
};

inline bool validAirMeasurement(float temperature, float humidity, float pressure) {
  return isfinite(temperature) && isfinite(humidity) && isfinite(pressure) &&
         temperature >= -40.0f && temperature <= 85.0f &&
         humidity >= 0.0f && humidity <= 100.0f &&
         pressure >= 300.0f && pressure <= 1100.0f;
}

inline bool validWaterMeasurement(float temperature) {
  return isfinite(temperature) &&
         temperature != -127.0f &&
         temperature != 85.0f &&
         temperature >= -55.0f && temperature <= 125.0f;
}

inline bool validCo2Measurement(uint16_t concentration) {
  return concentration >= 250U && concentration <= 40000U;
}

inline bool validIlluminanceMeasurement(float illuminance) {
  return isfinite(illuminance) && illuminance >= 0.0f && illuminance <= 200000.0f;
}
