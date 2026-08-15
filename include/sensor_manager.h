#pragma once

#include <Arduino.h>

namespace sensors {

using DelayHandler = void (*)(uint32_t milliseconds);

void begin(DelayHandler delayHandler);
bool readAir(float& temperature, float& humidity, float& pressure);
bool readWater(float& temperature);
bool readCo2(
  float pressureHpa,
  uint16_t& concentration,
  float& sensorTemperature,
  float& sensorHumidity);
bool readIlluminance(float& illuminance);
void invalidateAir();
void invalidateCo2();
void invalidateIlluminance();

}  // namespace sensors
