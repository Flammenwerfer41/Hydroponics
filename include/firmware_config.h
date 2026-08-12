#pragma once

#include <Arduino.h>

namespace firmware_config {

// Hardware wiring
constexpr int I2C_SDA_PIN = 18;
constexpr int I2C_SCL_PIN = 19;
constexpr int WATER_TEMPERATURE_PIN = 21;

// Sensor behavior
constexpr uint8_t DS18B20_RESOLUTION_BITS = 11;
constexpr uint32_t DS18B20_CONVERSION_MS = 375UL;
constexpr uint8_t MAX_CONSECUTIVE_AIR_SENSOR_FAILURES = 5;

// Scheduling and network recovery
constexpr uint32_t SAMPLE_INTERVAL_MS = 120000UL;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000UL;
constexpr uint32_t NTP_RETRY_INTERVAL_MS = 300000UL;
constexpr uint32_t OTA_RECEIVE_TIMEOUT_MS = 8000UL;
constexpr char TIMEZONE[] = "JST-9";

// Stable record contract
constexpr uint32_t VALID_EPOCH_MIN = 1704067200UL;
constexpr char FIRMWARE_VERSION[] = "8.4.0";
constexpr uint32_t FIRMWARE_VERSION_CODE = (8UL << 16) | (4UL << 8);

}  // namespace firmware_config
