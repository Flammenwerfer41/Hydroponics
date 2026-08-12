#include "ring_storage.h"

#include <Arduino.h>
#include <FS.h>
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "record_codec.h"

namespace {

constexpr bool FORMAT_LITTLEFS_IF_MOUNT_FAILED = false;
constexpr uint32_t RECORDS_PER_DAY = 24UL * 60UL / 2UL;
constexpr uint32_t MAX_RECORDS = 14UL * RECORDS_PER_DAY;
constexpr const char* LOG_FILE_PATH = "/sensor_ring_v8.bin";
constexpr const char* ACK_FILE_PATH = "/sensor_ack_v1.bin";
constexpr const char* LEGACY_LOG_FILE_PATH = "/sensor_ring.bin";
constexpr const char* LEGACY_V2_LOG_FILE_PATH = "/sensor_ring_v2.bin";
constexpr const char* LEGACY_V3_LOG_FILE_PATH = "/sensor_ring_v3.bin";
constexpr const char* LEGACY_V4_LOG_FILE_PATH = "/sensor_ring_v4.bin";
constexpr const char* LEGACY_V5_LOG_FILE_PATH = "/sensor_ring_v5.bin";
constexpr const char* LEGACY_V6_LOG_FILE_PATH = "/sensor_ring_v6.bin";
constexpr const char* LEGACY_V7_LOG_FILE_PATH = "/sensor_ring_v7.bin";
constexpr const char* LEGACY_LIGHT_EVENT_FILE_PATH = "/light_events.bin";
constexpr size_t FILESYSTEM_SAFETY_MARGIN = 128UL * 1024UL;
constexpr size_t RING_INITIALIZE_CHUNK_BYTES = 512UL;
constexpr size_t REQUIRED_LOG_BYTES = static_cast<size_t>(MAX_RECORDS) * sizeof(SensorRecord);
constexpr size_t REQUIRED_ACK_BYTES = static_cast<size_t>(MAX_RECORDS);
constexpr uint8_t DESTINATION_ACK_MASK = FLAG_CLOUDFLARE_OK;

int32_t newestSlot = -1;
SemaphoreHandle_t fsMutex = nullptr;
bool filesystemMounted = false;
bool readyState = false;
ring_storage::ServiceHandler serviceHandler = nullptr;

bool takeMutex(TickType_t waitTicks = portMAX_DELAY) {
  return fsMutex != nullptr && xSemaphoreTake(fsMutex, waitTicks) == pdTRUE;
}

void giveMutex() {
  if (fsMutex != nullptr) xSemaphoreGive(fsMutex);
}

void serviceStorageWork() {
  if (serviceHandler) serviceHandler();
  else yield();
}

}  // namespace

namespace ring_storage {

bool readRecordAt(File& file, uint32_t slot, SensorRecord& record) {
  size_t offset = static_cast<size_t>(slot) * sizeof(SensorRecord);
  if (!file.seek(offset, SeekSet)) return false;
  return file.read(reinterpret_cast<uint8_t*>(&record), sizeof(record)) == sizeof(record);
}

bool writeRecordAt(File& file, uint32_t slot, const SensorRecord& record) {
  size_t offset = static_cast<size_t>(slot) * sizeof(SensorRecord);
  if (!file.seek(offset, SeekSet)) return false;
  return file.write(reinterpret_cast<const uint8_t*>(&record), sizeof(record)) == sizeof(record);
}

bool readDestinationAckAt(File& file, uint32_t slot, uint8_t& flags) {
  if (!file.seek(slot, SeekSet)) return false;
  int value = file.read();
  if (value < 0) return false;
  flags = static_cast<uint8_t>(value) & DESTINATION_ACK_MASK;
  return true;
}

bool writeDestinationAckAt(File& file, uint32_t slot, uint8_t flags) {
  if (!file.seek(slot, SeekSet)) return false;
  return file.write(flags & DESTINATION_ACK_MASK) == 1;
}

bool removeLegacyStorageFiles() {
  const char* paths[] = {
    LEGACY_LOG_FILE_PATH,
    LEGACY_V2_LOG_FILE_PATH,
    LEGACY_V3_LOG_FILE_PATH,
    LEGACY_V4_LOG_FILE_PATH,
    LEGACY_V5_LOG_FILE_PATH,
    LEGACY_V6_LOG_FILE_PATH,
    LEGACY_V7_LOG_FILE_PATH,
    LEGACY_LIGHT_EVENT_FILE_PATH
  };
  for (const char* path : paths) {
    if (!LittleFS.exists(path)) continue;
    if (!LittleFS.remove(path)) {
      Serial.printf("ERROR: Could not remove legacy storage file %s.\n", path);
      return false;
    }
    Serial.printf("Removed legacy storage file %s.\n", path);
  }
  return true;
}

bool ensureRingFile() {
  if (!filesystemMounted) return false;
  File file = LittleFS.open(LOG_FILE_PATH, "r");
  size_t currentSize = file ? file.size() : 0;
  if (file) file.close();
  if (currentSize == REQUIRED_LOG_BYTES) return true;

  if (currentSize > 0 || LittleFS.exists(LOG_FILE_PATH)) {
    if (!LittleFS.remove(LOG_FILE_PATH)) {
      Serial.println("ERROR: Could not remove incomplete ring file.");
      return false;
    }
  }

  size_t usedBytes = LittleFS.usedBytes();
  size_t availableBytes = LittleFS.totalBytes() > usedBytes
    ? LittleFS.totalBytes() - usedBytes
    : 0;
  if (availableBytes < REQUIRED_LOG_BYTES + FILESYSTEM_SAFETY_MARGIN) {
    Serial.printf("ERROR: LittleFS free space is insufficient: %u bytes available.\n",
                  static_cast<unsigned>(availableBytes));
    return false;
  }

  Serial.printf("Creating sequential dual-destination ring file: %u bytes\n",
                static_cast<unsigned>(REQUIRED_LOG_BYTES));
  file = LittleFS.open(LOG_FILE_PATH, "w");
  if (!file) return false;

  static const uint8_t zeroBlock[RING_INITIALIZE_CHUNK_BYTES] = {};
  size_t bytesRemaining = REQUIRED_LOG_BYTES;
  size_t bytesWritten = 0;
  bool ok = true;
  while (bytesRemaining > 0) {
    size_t chunkSize = bytesRemaining < sizeof(zeroBlock)
      ? bytesRemaining
      : sizeof(zeroBlock);
    if (file.write(zeroBlock, chunkSize) != chunkSize) {
      ok = false;
      break;
    }
    bytesRemaining -= chunkSize;
    bytesWritten += chunkSize;
    if ((bytesWritten & 0x1FFFU) == 0) serviceStorageWork();
  }

  if (ok) file.flush();
  file.close();
  if (!ok) {
    LittleFS.remove(LOG_FILE_PATH);
    Serial.printf("ERROR: Ring initialization stopped after %u bytes.\n",
                  static_cast<unsigned>(bytesWritten));
    return false;
  }

  file = LittleFS.open(LOG_FILE_PATH, "r");
  bool validSize = file && file.size() == REQUIRED_LOG_BYTES;
  if (file) file.close();
  if (!validSize) {
    LittleFS.remove(LOG_FILE_PATH);
    Serial.println("ERROR: Ring file size verification failed.");
    return false;
  }
  Serial.println("Sequential ring file created and verified.");
  return true;
}

bool ensureDestinationAckFile() {
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r");
  size_t currentSize = ackFile ? ackFile.size() : 0;
  if (ackFile) ackFile.close();
  if (currentSize == REQUIRED_ACK_BYTES) return true;

  if (currentSize > 0 || LittleFS.exists(ACK_FILE_PATH)) {
    if (!LittleFS.remove(ACK_FILE_PATH)) {
      Serial.println("ERROR: Could not remove incomplete destination ack file.");
      return false;
    }
  }

  File ringFile = LittleFS.open(LOG_FILE_PATH, "r");
  ackFile = LittleFS.open(ACK_FILE_PATH, "w");
  if (!ringFile || !ackFile) {
    if (ringFile) ringFile.close();
    if (ackFile) ackFile.close();
    LittleFS.remove(ACK_FILE_PATH);
    return false;
  }

  Serial.printf("Creating destination ack sidecar: %u bytes\n",
                static_cast<unsigned>(REQUIRED_ACK_BYTES));
  bool ok = true;
  for (uint32_t slot = 0; slot < MAX_RECORDS; ++slot) {
    SensorRecord record{};
    if (!readRecordAt(ringFile, slot, record)) {
      ok = false;
      break;
    }
    uint8_t ackFlags = validStoredRecord(record)
      ? record.flags & DESTINATION_ACK_MASK
      : 0;
    if (ackFile.write(ackFlags) != 1) {
      ok = false;
      break;
    }
    if ((slot & 0x3FFU) == 0) serviceStorageWork();
  }
  if (ok) ackFile.flush();
  ringFile.close();
  ackFile.close();

  ackFile = LittleFS.open(ACK_FILE_PATH, "r");
  bool validSize = ok && ackFile && ackFile.size() == REQUIRED_ACK_BYTES;
  if (ackFile) ackFile.close();
  if (!validSize) {
    LittleFS.remove(ACK_FILE_PATH);
    Serial.println("ERROR: Destination ack sidecar initialization failed.");
    return false;
  }
  Serial.println("Destination ack sidecar created and verified.");
  return true;
}

bool scanRingFile() {
  newestSlot = -1;

  File file = LittleFS.open(LOG_FILE_PATH, "r");
  if (!file) return false;

  uint32_t newestTimestamp = 0;
  uint32_t validRecordCount = 0;
  uint32_t invalidRecordCount = 0;
  for (uint32_t slot = 0; slot < MAX_RECORDS; ++slot) {
    SensorRecord record{};
    if (!readRecordAt(file, slot, record)) {
      file.close();
      return false;
    }
    if (validStoredRecord(record)) {
      validRecordCount++;
      if (record.timestamp >= newestTimestamp) {
        newestTimestamp = record.timestamp;
        newestSlot = static_cast<int32_t>(slot);
      }
    } else if (record.timestamp != 0 || record.flags != 0) {
      invalidRecordCount++;
    }
    if ((slot & 0x3FFU) == 0) yield();
  }
  file.close();

  Serial.printf("Ring scan: %u valid, %u invalid, newest slot %ld\n",
                validRecordCount, invalidRecordCount, static_cast<long>(newestSlot));
  return true;
}


bool begin(ServiceHandler handler) {
  serviceHandler = handler;
  if (!fsMutex) fsMutex = xSemaphoreCreateMutex();
  if (!fsMutex) {
    Serial.println("ERROR: LittleFS mutex creation failed.");
    return false;
  }
  filesystemMounted = false;
  readyState = false;

  if (!LittleFS.begin(FORMAT_LITTLEFS_IF_MOUNT_FAILED)) {
    Serial.println("LittleFS mount failed. Existing data was not auto-formatted.");
    return false;
  }
  filesystemMounted = true;

  // v5/v6 exceeded LittleFS's safe copy-on-write budget. Their presence is a
  // one-time migration marker: format before creating the smaller v7 ring.
  if (LittleFS.exists(LEGACY_V5_LOG_FILE_PATH) ||
      LittleFS.exists(LEGACY_V6_LOG_FILE_PATH)) {
    Serial.println("Oversized legacy ring detected; reformatting LittleFS once.");
    LittleFS.end();
    filesystemMounted = false;
    if (!LittleFS.format() || !LittleFS.begin(false)) {
      Serial.println("ERROR: LittleFS migration format or remount failed.");
      return false;
    }
    filesystemMounted = true;
    Serial.println("LittleFS migration format completed.");
  }

  Serial.printf("Flash: %u bytes\n", ESP.getFlashChipSize());
  Serial.printf("LittleFS total: %u bytes\n", LittleFS.totalBytes());
  Serial.printf("LittleFS used: %u bytes\n", LittleFS.usedBytes());
  Serial.printf("Ring required: %u bytes\n", static_cast<unsigned>(REQUIRED_LOG_BYTES));
  Serial.printf("Ack sidecar required: %u bytes\n",
                static_cast<unsigned>(REQUIRED_ACK_BYTES));

  // Updating the beginning of a LittleFS file may temporarily require a second
  // copy of the file's data. Keep room for both copies plus filesystem metadata.
  size_t totalRequired = REQUIRED_LOG_BYTES * 2UL +
                         REQUIRED_ACK_BYTES * 2UL +
                         FILESYSTEM_SAFETY_MARGIN;
  if (LittleFS.totalBytes() < totalRequired) {
    Serial.println("ERROR: LittleFS partition is too small for safe ring overwrites.");
    return false;
  }

  if (!takeMutex(pdMS_TO_TICKS(2000))) {
    Serial.println("ERROR: Could not lock LittleFS during initialization.");
    return false;
  }
  bool ok = removeLegacyStorageFiles() &&
            ensureRingFile() &&
            ensureDestinationAckFile() &&
            scanRingFile();
  giveMutex();

  readyState = ok;
  if (!ok) Serial.println("ERROR: LittleFS files could not be initialized or scanned.");
  return ok;
}

bool appendRecord(const SensorRecord& record, uint32_t& writtenSlot) {
  writtenSlot = UINT32_MAX;
  if (!readyState || !validStoredRecord(record)) return false;
  if (!takeMutex(pdMS_TO_TICKS(1000))) return false;

  uint32_t nextSlot = newestSlot < 0 ? 0 : (static_cast<uint32_t>(newestSlot) + 1UL) % MAX_RECORDS;
  // Clear acknowledgements before replacing a slot. A power loss between these
  // writes can cause a harmless retry of the old record, but can never make a
  // new record inherit stale destination acknowledgements.
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r+");
  bool ackReset = ackFile && writeDestinationAckAt(ackFile, nextSlot, 0);
  if (ackFile) {
    if (ackReset) ackFile.flush();
    ackFile.close();
  }
  if (!ackReset) {
    giveMutex();
    return false;
  }

  File file = LittleFS.open(LOG_FILE_PATH, "r+");
  if (!file) {
    giveMutex();
    return false;
  }

  SensorRecord previous{};
  bool ok = readRecordAt(file, nextSlot, previous) &&
            writeRecordAt(file, nextSlot, record);
  file.flush();
  file.close();

  if (ok) {
    newestSlot = static_cast<int32_t>(nextSlot);
    writtenSlot = nextSlot;
  }
  giveMutex();
  return ok;
}

bool validDestinationFlag(uint8_t flag) {
  return flag == FLAG_CLOUDFLARE_OK;
}

bool markRecordDestinationOk(
    uint32_t slot,
    const SensorRecord& expected,
    uint8_t destinationFlag) {
  if (!readyState || slot >= MAX_RECORDS ||
      !validDestinationFlag(destinationFlag)) return false;
  if (!takeMutex(pdMS_TO_TICKS(1000))) return false;

  File ringFile = LittleFS.open(LOG_FILE_PATH, "r");
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r+");
  if (!ringFile || !ackFile) {
    if (ringFile) ringFile.close();
    if (ackFile) ackFile.close();
    giveMutex();
    return false;
  }
  SensorRecord record{};
  uint8_t ackFlags = 0;
  bool ok = readRecordAt(ringFile, slot, record) &&
            readDestinationAckAt(ackFile, slot, ackFlags);
  if (ok && validStoredRecord(record) && sameRecordIdentity(record, expected)) {
    ok = writeDestinationAckAt(ackFile, slot, ackFlags | destinationFlag);
  } else {
    ok = false;
  }
  if (ok) ackFile.flush();
  ringFile.close();
  ackFile.close();
  giveMutex();
  return ok;
}

size_t collectPendingDestinationRecords(
    StoredRecordRef* records,
    size_t capacity,
    uint8_t destinationFlag) {
  if (!readyState || records == nullptr || capacity == 0 ||
      !validDestinationFlag(destinationFlag)) return 0;
  if (!takeMutex(pdMS_TO_TICKS(2000))) return 0;

  File file = LittleFS.open(LOG_FILE_PATH, "r");
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r");
  if (!file || !ackFile) {
    if (file) file.close();
    if (ackFile) ackFile.close();
    giveMutex();
    return 0;
  }

  size_t count = 0;
  uint32_t startSlot = newestSlot < 0
    ? 0
    : (static_cast<uint32_t>(newestSlot) + 1UL) % MAX_RECORDS;
  for (uint32_t offset = 0; offset < MAX_RECORDS && count < capacity; ++offset) {
    uint32_t slot = (startSlot + offset) % MAX_RECORDS;
    SensorRecord record{};
    uint8_t ackFlags = 0;
    if (!readRecordAt(file, slot, record) ||
        !readDestinationAckAt(ackFile, slot, ackFlags)) break;
    if (validStoredRecord(record) && (ackFlags & destinationFlag) == 0) {
      records[count].record = record;
      records[count].slot = slot;
      count++;
    }
    if ((offset & 0x3FFU) == 0) yield();
  }

  file.close();
  ackFile.close();
  giveMutex();
  return count;
}

size_t markRecordsDestinationOk(
    const StoredRecordRef* records,
    size_t count,
    uint8_t destinationFlag) {
  if (!readyState || records == nullptr || count == 0 ||
      !validDestinationFlag(destinationFlag)) return 0;
  if (!takeMutex(pdMS_TO_TICKS(2000))) return 0;

  File ringFile = LittleFS.open(LOG_FILE_PATH, "r");
  File ackFile = LittleFS.open(ACK_FILE_PATH, "r+");
  if (!ringFile || !ackFile) {
    if (ringFile) ringFile.close();
    if (ackFile) ackFile.close();
    giveMutex();
    return 0;
  }

  size_t marked = 0;
  for (size_t index = 0; index < count; ++index) {
    SensorRecord stored{};
    uint8_t ackFlags = 0;
    bool matches = readRecordAt(ringFile, records[index].slot, stored) &&
                   readDestinationAckAt(ackFile, records[index].slot, ackFlags) &&
                   validStoredRecord(stored) &&
                   sameRecordIdentity(stored, records[index].record);
    if (!matches) continue;
    if (writeDestinationAckAt(
          ackFile, records[index].slot, ackFlags | destinationFlag)) marked++;
  }
  if (marked > 0) ackFile.flush();
  ringFile.close();
  ackFile.close();
  giveMutex();
  return marked;
}


bool ready() {
  return readyState;
}

bool validSlot(uint32_t slot) {
  return slot < MAX_RECORDS;
}

}  // namespace ring_storage

