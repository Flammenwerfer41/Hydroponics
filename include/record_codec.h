#pragma once

#include <Arduino.h>
#include <esp_system.h>

#include "telemetry_record.h"

const char* resetReasonName(esp_reset_reason_t reason);
void formatBootId(uint64_t bootId, char* buffer, size_t bufferSize);
void formatReadingId(const SensorRecord& record, char* buffer, size_t bufferSize);
bool sameRecordIdentity(const SensorRecord& left, const SensorRecord& right);
bool validStoredRecord(const SensorRecord& record);

bool appendCloudflareReadingJson(String& payload, const SensorRecord& record);
bool responseAcknowledgesReading(const String& response, const SensorRecord& record);
