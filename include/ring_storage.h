#pragma once

#include <Arduino.h>

#include "telemetry_record.h"

namespace ring_storage {

using ServiceHandler = void (*)();

bool begin(ServiceHandler handler);
bool ready();
bool validSlot(uint32_t slot);
bool appendRecord(const SensorRecord& record, uint32_t& writtenSlot);
bool markRecordDestinationOk(
  uint32_t slot,
  const SensorRecord& expected,
  uint8_t destinationFlag);
size_t collectPendingDestinationRecords(
  StoredRecordRef* records,
  size_t capacity,
  uint8_t destinationFlag);
size_t markRecordsDestinationOk(
  const StoredRecordRef* records,
  size_t count,
  uint8_t destinationFlag);

}  // namespace ring_storage

