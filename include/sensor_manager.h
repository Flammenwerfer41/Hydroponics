#pragma once

#include <Arduino.h>

namespace sensors {

using DelayHandler = void (*)(uint32_t milliseconds);

void begin(DelayHandler delayHandler);
bool readAir(float& temperature, float& humidity, float& pressure);
bool readWater(float& temperature);
void invalidateAir();

}  // namespace sensors
