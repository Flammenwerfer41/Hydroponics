#pragma once

#include <Arduino.h>
#include "telemetry_record.h"

namespace cloud_upload {
using PauseHandler = bool (*)();
void configure(const char* ingestionUrl, const char* deviceToken);
bool configured();
bool begin(PauseHandler handler);
bool enqueue(const SensorRecord& record, uint32_t slot);
}  // namespace cloud_upload
