#pragma once

#include <Arduino.h>
#include <math.h>

enum RecordFlags : uint8_t {
  FLAG_BME280_VALID = 1 << 0,
  FLAG_WATER_VALID = 1 << 1,
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
  int8_t rssi;
  uint8_t flags;
  uint8_t resetReason;
  uint8_t reserved;
};
static_assert(sizeof(SensorRecord) == 40, "SensorRecord must remain 40 bytes");

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
