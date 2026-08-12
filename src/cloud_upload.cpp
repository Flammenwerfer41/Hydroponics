#include "cloud_upload.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <string.h>

#include "record_codec.h"
#include "ring_storage.h"

// Trust both workers.dev TLS 1.2 paths currently served by Cloudflare. Some
// edges send the WE1 chain through the cross-signed GTS Root R4 to the legacy
// GlobalSign Root R1, while desktop clients can build an alternate path to the
// GlobalSign ECC Root R4. Verification still fails closed for other chains.
const char CLOUDFLARE_ROOT_CAS[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIB3DCCAYOgAwIBAgINAgPlfvU/k/2lCSGypjAKBggqhkjOPQQDAjBQMSQwIgYD
VQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2Jh
bFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMTIxMTEzMDAwMDAwWhcNMzgw
MTE5MDMxNDA3WjBQMSQwIgYDVQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0g
UjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAAS4xnnTj2wlDp8uORkcA6SumuU5BwkWymOx
uYb4ilfBV85C+nOh92VC/x7BALJucw7/xyHlGKSq2XE/qNS5zowdo0IwQDAOBgNV
HQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUVLB7rUW44kB/
+wpu+74zyTyjhNUwCgYIKoZIzj0EAwIDRwAwRAIgIk90crlgr/HmnKAWBVBfw147
bmF0774BxL4YSFlhgjICICadVGNA3jdgUM/I2O2dgq43mLyjj0xMqTQrbO/7lZsm
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkG
A1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jv
b3QgQ0ExGzAZBgNVBAMTEkdsb2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAw
MDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9i
YWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJHbG9iYWxT
aWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaDuaZ
jc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavp
xy0Sy6scTHAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp
1Wrjsok6Vjk4bwY8iGlbKk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdG
snUOhugZitVtbNV4FpWi6cgKOOvyJBNPc1STE4U6G7weNLWLBYy5d4ux2x8gkasJ
U26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrXgzT/LCrBbBlDSgeF59N8
9iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8E
BTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0B
AQUFAAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOz
yj1hTdNGCbM+w6DjY1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE
38NflNUVyRRBnMRddWQVDf9VMOyGj/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymP
AbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhHhm4qxFYxldBniYUr+WymXUad
DKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveCX4XSQRjbgbME
HMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==
-----END CERTIFICATE-----
)EOF";

namespace {

constexpr uint8_t CLOUDFLARE_QUEUE_LENGTH = 4;
constexpr uint32_t CLOUDFLARE_TASK_STACK = 8192;
constexpr uint8_t CLOUDFLARE_BULK_BATCH_SIZE = 15;
constexpr uint32_t CLOUDFLARE_HTTP_TIMEOUT_MS = 15000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_INITIAL_MS = 30000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_MAX_MS = 30UL * 60UL * 1000UL;
constexpr uint32_t CLOUDFLARE_BACKOFF_JITTER_MS = 5000UL;

struct CloudflareJob {
  SensorRecord record;
  uint32_t slot;
};

QueueHandle_t cloudflareQueue = nullptr;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t cloudflareTaskHandle = nullptr;
StoredRecordRef bulkUploadBatch[CLOUDFLARE_BULK_BATCH_SIZE]{};
uint32_t droppedUploadJobs = 0;
uint32_t consecutiveCloudflareFailures = 0;
uint32_t cloudflareRecoveryBackoffMs = 0;
uint32_t nextCloudflareRecoveryMs = 0;
cloud_upload::PauseHandler pauseHandler = nullptr;
const char* ingestionUrl = "";
const char* deviceToken = "";

bool paused() {
  return pauseHandler && pauseHandler();
}

bool takeStateMutex(TickType_t waitTicks = portMAX_DELAY) {
  return stateMutex != nullptr &&
         xSemaphoreTake(stateMutex, waitTicks) == pdTRUE;
}

void giveStateMutex() {
  if (stateMutex != nullptr) xSemaphoreGive(stateMutex);
}

void noteEnqueueFailure() {
  if (!takeStateMutex(portMAX_DELAY)) return;
  if (consecutiveCloudflareFailures < UINT32_MAX) {
    consecutiveCloudflareFailures++;
  }
  giveStateMutex();
}

}  // namespace

namespace cloud_upload {

void configure(const char* url, const char* token) {
  ingestionUrl = url ? url : "";
  deviceToken = token ? token : "";
}

bool configured() {
  return strncmp(ingestionUrl, "https://", 8) == 0 &&
         strlen(deviceToken) >= 24;
}

bool deadlineReached(uint32_t deadline) {
  return deadline == 0 || static_cast<int32_t>(millis() - deadline) >= 0;
}

void resetCloudflareBackoff() {
  cloudflareRecoveryBackoffMs = 0;
  nextCloudflareRecoveryMs = 0;
}

void scheduleCloudflareBackoff() {
  if (cloudflareRecoveryBackoffMs == 0) {
    cloudflareRecoveryBackoffMs = CLOUDFLARE_BACKOFF_INITIAL_MS;
  } else {
    uint64_t doubled = static_cast<uint64_t>(cloudflareRecoveryBackoffMs) * 2ULL;
    cloudflareRecoveryBackoffMs = doubled > CLOUDFLARE_BACKOFF_MAX_MS
      ? CLOUDFLARE_BACKOFF_MAX_MS
      : static_cast<uint32_t>(doubled);
  }
  uint32_t jitter = CLOUDFLARE_BACKOFF_JITTER_MS == 0
    ? 0
    : esp_random() % CLOUDFLARE_BACKOFF_JITTER_MS;
  nextCloudflareRecoveryMs = millis() + cloudflareRecoveryBackoffMs + jitter;
  Serial.printf("Cloudflare recovery backoff: %lu ms.\n",
                static_cast<unsigned long>(cloudflareRecoveryBackoffMs + jitter));
}

int postCloudflarePayload(const String& url, const String& payload, String& response) {
  if (!configured() || WiFi.status() != WL_CONNECTED || paused()) return -1000;
  WiFiClientSecure client;
  client.setCACert(CLOUDFLARE_ROOT_CAS);
  HTTPClient http;
  if (!http.begin(client, url)) {
    Serial.println("Cloudflare HTTP begin failed.");
    return -1001;
  }
  http.setTimeout(CLOUDFLARE_HTTP_TIMEOUT_MS);
  http.addHeader("Authorization", String("Bearer ") + deviceToken);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(payload);
  response = code > 0 ? http.getString() : String();
  http.end();
  return code;
}

bool uploadToCloudflare(const SensorRecord& record) {
  if (!configured()) return false;
  String payload;
  if (!payload.reserve(480) || !appendCloudflareReadingJson(payload, record)) {
    Serial.println("Cloudflare upload skipped: payload allocation or formatting failed.");
    return false;
  }
  String response;
  int code = postCloudflarePayload(ingestionUrl, payload, response);
  bool acknowledged = (code == 200 || code == 201) &&
                      responseAcknowledgesReading(response, record);
  if (acknowledged) {
    Serial.printf("Cloudflare acknowledged reading %lu.\n",
                  static_cast<unsigned long>(record.sequence));
  } else {
    Serial.printf("Cloudflare upload not acknowledged: HTTP %d.\n", code);
  }
  return acknowledged;
}

void recoverPendingCloudflareRecords() {
  if (!configured() || !deadlineReached(nextCloudflareRecoveryMs) ||
      WiFi.status() != WL_CONNECTED || paused()) return;
  size_t count = ring_storage::collectPendingDestinationRecords(
    bulkUploadBatch, CLOUDFLARE_BULK_BATCH_SIZE, FLAG_CLOUDFLARE_OK);
  if (count == 0) {
    resetCloudflareBackoff();
    return;
  }

  String payload;
  if (!payload.reserve(96 + count * 430U)) {
    Serial.println("Cloudflare recovery skipped: insufficient heap for JSON payload.");
    scheduleCloudflareBackoff();
    return;
  }
  payload += F("{\"schema_version\":1,\"readings\":[");
  size_t appended = 0;
  for (size_t index = 0; index < count; ++index) {
    if (appended > 0) payload += ',';
    if (appendCloudflareReadingJson(payload, bulkUploadBatch[index].record)) appended++;
  }
  payload += F("]}");
  if (appended != count) {
    Serial.println("Cloudflare recovery formatting failed; records remain pending.");
    scheduleCloudflareBackoff();
    return;
  }

  Serial.printf("Cloudflare recovery: uploading %u oldest pending records.\n",
                static_cast<unsigned>(count));
  String response;
  int code = postCloudflarePayload(
    String(ingestionUrl) + F("/bulk"), payload, response);
  if (code != 200) {
    Serial.printf("Cloudflare recovery failed: HTTP %d.\n", code);
    scheduleCloudflareBackoff();
    return;
  }

  size_t acknowledged = 0;
  for (size_t index = 0; index < count; ++index) {
    if (!responseAcknowledgesReading(response, bulkUploadBatch[index].record)) continue;
    if (acknowledged != index) bulkUploadBatch[acknowledged] = bulkUploadBatch[index];
    acknowledged++;
  }
  size_t marked = ring_storage::markRecordsDestinationOk(
    bulkUploadBatch, acknowledged, FLAG_CLOUDFLARE_OK);
  Serial.printf("Cloudflare recovery: %u acknowledged, %u marked complete.\n",
                static_cast<unsigned>(acknowledged), static_cast<unsigned>(marked));
  if (acknowledged == count && marked == acknowledged) resetCloudflareBackoff();
  else scheduleCloudflareBackoff();
}

// ================= CLOUDFLARE UPLOAD TASK =================
void cloudflareTask(void* parameter) {
  CloudflareJob job{};
  for (;;) {
    if (xQueueReceive(cloudflareQueue, &job, portMAX_DELAY) != pdTRUE) continue;
    while (paused()) vTaskDelay(pdMS_TO_TICKS(100));
    bool cloudflareOk = uploadToCloudflare(job.record);

    if (takeStateMutex(portMAX_DELAY)) {
      if (cloudflareOk) consecutiveCloudflareFailures = 0;
      else if (consecutiveCloudflareFailures < UINT32_MAX) consecutiveCloudflareFailures++;
      giveStateMutex();
    }

    if (cloudflareOk && ring_storage::validSlot(job.slot) &&
        !ring_storage::markRecordDestinationOk(
          job.slot, job.record, FLAG_CLOUDFLARE_OK)) {
      Serial.println("Failed to update local Cloudflare acknowledgement flag.");
    }
    if (cloudflareOk) resetCloudflareBackoff();
    else {
      Serial.printf("Cloudflare upload failed; local record retained. Consecutive failures: %lu\n",
                    static_cast<unsigned long>(consecutiveCloudflareFailures));
      scheduleCloudflareBackoff();
    }
    recoverPendingCloudflareRecords();
  }
}

bool begin(PauseHandler handler) {
  pauseHandler = handler;
  if (!stateMutex) stateMutex = xSemaphoreCreateMutex();
  if (!stateMutex) {
    Serial.println("ERROR: Cloudflare state mutex creation failed.");
    return false;
  }
  cloudflareQueue = xQueueCreate(CLOUDFLARE_QUEUE_LENGTH, sizeof(CloudflareJob));
  if (!cloudflareQueue) {
    Serial.println("ERROR: Cloudflare queue creation failed.");
    return false;
  }
  BaseType_t result = xTaskCreatePinnedToCore(
    cloudflareTask, "Cloudflare", CLOUDFLARE_TASK_STACK,
    nullptr, 1, &cloudflareTaskHandle, 0);
  if (result != pdPASS) {
    Serial.println("ERROR: Cloudflare task creation failed.");
    vQueueDelete(cloudflareQueue);
    cloudflareQueue = nullptr;
    return false;
  }
  Serial.println("Cloud upload task started.");
  return true;
}

bool enqueue(const SensorRecord& record, uint32_t slot) {
  if (!cloudflareQueue) {
    noteEnqueueFailure();
    return false;
  }
  CloudflareJob job{};
  job.record = record;
  job.slot = slot;
  if (xQueueSend(cloudflareQueue, &job, 0) == pdTRUE) return true;
  droppedUploadJobs++;
  noteEnqueueFailure();
  Serial.printf("Cloud upload queue full; dropped upload job. Total dropped: %lu\n",
                static_cast<unsigned long>(droppedUploadJobs));
  return false;
}


}  // namespace cloud_upload
