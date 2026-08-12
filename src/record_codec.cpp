#include "record_codec.h"

#include <time.h>

#include "firmware_config.h"

namespace {

bool formatUtcTimeToBuffer(time_t value, char* buffer, size_t bufferSize) {
  if (bufferSize == 0 ||
      value < static_cast<time_t>(firmware_config::VALID_EPOCH_MIN) ||
      static_cast<uint64_t>(value) > UINT32_MAX) return false;
  struct tm utcTime{};
  gmtime_r(&value, &utcTime);
  return strftime(buffer, bufferSize, "%Y-%m-%dT%H:%M:%SZ", &utcTime) > 0;
}

void formatFirmwareVersion(uint32_t version, char* buffer, size_t bufferSize) {
  snprintf(buffer, bufferSize, "%lu.%lu.%lu",
           static_cast<unsigned long>((version >> 16) & 0xFFU),
           static_cast<unsigned long>((version >> 8) & 0xFFU),
           static_cast<unsigned long>(version & 0xFFU));
}

void appendJsonNumberOrNull(String& payload, float value, bool valid, uint8_t digits = 3) {
  if (valid && isfinite(value)) {
    payload += String(value, static_cast<unsigned int>(digits));
  } else {
    payload += F("null");
  }
}

}  // namespace

const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}

void formatBootId(uint64_t bootId, char* buffer, size_t bufferSize) {
  snprintf(buffer, bufferSize, "%08lx%08lx",
           static_cast<unsigned long>(bootId >> 32),
           static_cast<unsigned long>(bootId & 0xFFFFFFFFULL));
}

void formatReadingId(const SensorRecord& record, char* buffer, size_t bufferSize) {
  char bootId[17];
  formatBootId(record.bootId, bootId, sizeof(bootId));
  snprintf(buffer, bufferSize, "%s:%lu", bootId,
           static_cast<unsigned long>(record.sequence));
}

bool sameRecordIdentity(const SensorRecord& left, const SensorRecord& right) {
  return left.timestamp == right.timestamp &&
         left.bootId == right.bootId &&
         left.sequence == right.sequence;
}

bool validStoredRecord(const SensorRecord& record) {
  bool bme280Valid = (record.flags & FLAG_BME280_VALID) != 0;
  bool waterValid = (record.flags & FLAG_WATER_VALID) != 0;
  return record.timestamp >= firmware_config::VALID_EPOCH_MIN &&
         record.bootId != 0 &&
         record.firmwareVersion != 0 &&
         (bme280Valid || waterValid) &&
         (!bme280Valid || validAirMeasurement(
           record.temperature, record.humidity, record.pressure)) &&
         (!waterValid || validWaterMeasurement(record.waterTemperature));
}

bool appendCloudflareReadingJson(String& payload, const SensorRecord& record) {
  if (!validStoredRecord(record)) return false;
  char measuredAt[25];
  if (!formatUtcTimeToBuffer(record.timestamp, measuredAt, sizeof(measuredAt))) return false;
  char bootId[17];
  char readingId[40];
  char firmwareVersion[16];
  formatBootId(record.bootId, bootId, sizeof(bootId));
  formatReadingId(record, readingId, sizeof(readingId));
  formatFirmwareVersion(record.firmwareVersion, firmwareVersion, sizeof(firmwareVersion));

  bool bmeValid = (record.flags & FLAG_BME280_VALID) != 0;
  bool waterValid = (record.flags & FLAG_WATER_VALID) != 0;
  bool rssiValid = record.rssi < 0;

  payload += F("{\"schema_version\":1,\"reading_id\":\"");
  payload += readingId;
  payload += F("\",\"boot_id\":\"");
  payload += bootId;
  payload += F("\",\"sequence\":");
  payload += String(record.sequence);
  payload += F(",\"measured_at\":\"");
  payload += measuredAt;
  payload += F("\",\"firmware_version\":\"");
  payload += firmwareVersion;
  payload += F("\",\"reset_reason\":\"");
  payload += resetReasonName(static_cast<esp_reset_reason_t>(record.resetReason));
  payload += F("\",\"values\":{\"air_temperature\":");
  appendJsonNumberOrNull(payload, record.temperature, bmeValid);
  payload += F(",\"humidity\":");
  appendJsonNumberOrNull(payload, record.humidity, bmeValid);
  payload += F(",\"pressure\":");
  appendJsonNumberOrNull(payload, record.pressure, bmeValid);
  payload += F(",\"wifi_rssi\":");
  if (rssiValid) payload += String(static_cast<int>(record.rssi));
  else payload += F("null");
  payload += F(",\"water_temperature\":");
  appendJsonNumberOrNull(payload, record.waterTemperature, waterValid);
  payload += F("}}");
  return true;
}

bool responseAcknowledgesReading(const String& response, const SensorRecord& record) {
  char readingId[40];
  formatReadingId(record, readingId, sizeof(readingId));
  String quotedReadingId = String('"') + readingId + '"';
  int readingPosition = response.indexOf(quotedReadingId);
  if (readingPosition < 0) return false;
  int statusPosition = response.indexOf(F("\"status\""), readingPosition + quotedReadingId.length());
  if (statusPosition < 0) return false;
  int nextReadingPosition = response.indexOf(F("\"reading_id\""), readingPosition + quotedReadingId.length());
  if (nextReadingPosition >= 0 && nextReadingPosition < statusPosition) return false;
  int colon = response.indexOf(':', statusPosition);
  int valueStart = colon >= 0 ? response.indexOf('"', colon + 1) : -1;
  int valueEnd = valueStart >= 0 ? response.indexOf('"', valueStart + 1) : -1;
  if (valueStart < 0 || valueEnd < 0) return false;
  String status = response.substring(valueStart + 1, valueEnd);
  return status == "accepted" || status == "duplicate";
}
