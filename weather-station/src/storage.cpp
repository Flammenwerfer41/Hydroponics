#include "station.h"
#include <cmath>
#include <cstring>
#include <ctime>
#include "nvs_flash.h"
#include "nvs.h"

static nvs_handle_t records, state;
struct QueueState { uint32_t head = 0, count = 0, lost = 0; };
static QueueState queue;
// Keep the original observation blob readable by the previous firmware on rollback.
// Optional sidecar is tied to observation identity; a reused slot cannot inherit old metadata.
struct ScheduleSidecar {
    char identity[33] = {};
    uint32_t sequence = 0, normalPeriod = 0, appliedPeriod = 0, revision = 0, reason = 0;
};
struct AstroSidecar : ScheduleSidecar { solar::Snapshot astronomy{}; };
static void slotKey(uint32_t slot, char* key) { snprintf(key, 12, "q%04lu", (unsigned long)slot); }
static bool commitQueue() {
    return nvs_set_blob(records, "queue", &queue, sizeof(queue)) == ESP_OK &&
           nvs_commit(records) == ESP_OK;
}
bool initStorage() {
    // Never erase records/NVS automatically on error or format mismatch.
    if (nvs_flash_init() != ESP_OK || nvs_flash_init_partition("records") != ESP_OK ||
        nvs_open_from_partition("records", "readings", NVS_READWRITE, &records) != ESP_OK ||
        nvs_open("station", NVS_READWRITE, &state) != ESP_OK) return false;
    size_t size = sizeof(queue);
    esp_err_t error = nvs_get_blob(records, "queue", &queue, &size);
    return (error == ESP_ERR_NVS_NOT_FOUND || (error == ESP_OK && size == sizeof(queue))) &&
           queue.head < policy::queueCapacity && queue.count <= policy::queueCapacity;
}
bool enqueue(const Record& record) {
    if (!record.epoch) return false;
    if (queue.count == policy::queueCapacity) {
        // Commit eviction before overwriting: power loss cannot make a new value look like the oldest.
        queue.head = (queue.head + 1) % policy::queueCapacity;
        --queue.count; ++queue.lost;
        if (!commitQueue()) return false;
    }
    char key[12]; slotKey((queue.head + queue.count) % policy::queueCapacity, key);
    RecordV1 legacy = record; legacy.format = 1;
    if (nvs_set_blob(records, key, &legacy, sizeof(legacy)) != ESP_OK) return false;
    char metaKey[13]; snprintf(metaKey, sizeof(metaKey), "s%s", key);
    AstroSidecar meta{};
    strlcpy(meta.identity, record.identity, sizeof(meta.identity)); meta.sequence = record.sequence;
    meta.normalPeriod = record.normalPeriod; meta.appliedPeriod = record.appliedPeriod;
    meta.revision = record.configRevision; meta.reason = record.scheduleReason;
    meta.astronomy = record.astronomy;
    if (nvs_set_blob(records, metaKey, &meta, sizeof(meta)) != ESP_OK || nvs_commit(records) != ESP_OK)
        return false;
    ++queue.count;
    return commitQueue();
}
bool oldest(Record& record) {
    if (!queue.count) return false;
    char key[12]; slotKey(queue.head, key);
    size_t size = 0;
    if (nvs_get_blob(records, key, nullptr, &size) != ESP_OK) return false;
    if (size == sizeof(RecordV1)) {
        RecordV1 legacy{};
        if (nvs_get_blob(records, key, &legacy, &size) != ESP_OK || legacy.format != 1) return false;
        record = {}; static_cast<RecordV1&>(record) = legacy;
        char metaKey[13]; snprintf(metaKey, sizeof(metaKey), "s%s", key);
        AstroSidecar meta{}; size_t metaSize = 0;
        auto metaResult=nvs_get_blob(records,metaKey,nullptr,&metaSize);
        if (metaResult==ESP_OK && metaSize==sizeof(ScheduleSidecar)) {
            ScheduleSidecar old{};
            metaResult=nvs_get_blob(records,metaKey,&old,&metaSize);
            static_cast<ScheduleSidecar&>(meta)=old;
        } else if (metaResult==ESP_OK && metaSize==sizeof(meta)) metaResult=nvs_get_blob(records,metaKey,&meta,&metaSize);
        else metaResult=ESP_ERR_INVALID_SIZE;
        if (metaResult == ESP_OK &&
            !memcmp(meta.identity, record.identity, sizeof(meta.identity)) && meta.sequence == record.sequence &&
            policy::validPeriod(meta.normalPeriod) && policy::validPeriod(meta.appliedPeriod) && meta.reason >= 1 && meta.reason <= 4) {
            record.format = 2; record.normalPeriod = meta.normalPeriod; record.appliedPeriod = meta.appliedPeriod;
            record.configRevision = meta.revision; record.scheduleReason = meta.reason;
            record.astronomy = meta.astronomy;
        }
        return true;
    }
    return false; // Unknown layouts are not erased or guessed.
}
bool dequeue() {
    if (!queue.count) return false;
    // Keep slot contents until reused; ack cursor only advances after server acknowledgement.
    queue.head = (queue.head + 1) % policy::queueCapacity;
    --queue.count;
    return commitQueue();
}
int queued() { return queue.count; }
uint32_t dropped() { return queue.lost; }
bool loadRetry(RetryState& retry) {
    size_t size = sizeof(retry);
    const auto error = nvs_get_blob(state, "ota", &retry, &size);
    if (error == ESP_ERR_NVS_NOT_FOUND) { retry = {}; return true; }
    return error == ESP_OK && size == sizeof(retry) && retry.hash[64] == '\0' &&
           (strlen(retry.hash) == 0 || (strlen(retry.hash) == 64 && strspn(retry.hash, "0123456789abcdef") == 64)) &&
           retry.attempts >= 0 && retry.attempts <= policy::maxOtaAttempts && retry.next >= 0;
}
bool saveRetry(const RetryState& retry) {
    return nvs_set_blob(state, "ota", &retry, sizeof(retry)) == ESP_OK && nvs_commit(state) == ESP_OK;
}
bool consumeMaintenance(const char* id) {
    if (!id || strlen(id) != 36) return false;
    char previous[64] = {}; size_t size = sizeof(previous);
    auto error = nvs_get_str(state, "maintenance", previous, &size);
    if (error != ESP_OK && error != ESP_ERR_NVS_NOT_FOUND) return false;
    if (!strcmp(id, previous)) return false;
    return nvs_set_str(state, "maintenance", id) == ESP_OK && nvs_commit(state) == ESP_OK;
}
cJSON* recordJson(const Record& record) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "schema_version", 1);
    char id[48]; snprintf(id, sizeof(id), "%s:%lu", record.identity, (unsigned long)record.sequence);
    cJSON_AddStringToObject(root, "reading_id", id);
    cJSON_AddStringToObject(root, "boot_id", record.identity);
    cJSON_AddNumberToObject(root, "sequence", record.sequence);
    time_t epoch = record.epoch; tm utc{}; gmtime_r(&epoch, &utc);
    char timestamp[32]; strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc);
    cJSON_AddStringToObject(root, "measured_at", timestamp);
    cJSON_AddStringToObject(root, "firmware_version", record.version);
    if (record.astronomy.modelId==solar::model) {
        auto astro=cJSON_AddObjectToObject(root,"astronomy");
        cJSON_AddStringToObject(astro,"model",solar::modelName);
        cJSON_AddNumberToObject(astro,"solar_altitude_deg",record.astronomy.altitudeCenti/100.0);
        cJSON_AddBoolToObject(astro,"night",record.astronomy.night);
        cJSON_AddBoolToObject(astro,"night_closing",record.astronomy.closing);
        const auto stamp=[&](const char* name, int64_t value) {
            time_t t=value; tm utc{}; gmtime_r(&t,&utc); char s[32]; strftime(s,sizeof(s),"%Y-%m-%dT%H:%M:%SZ",&utc);
            cJSON_AddStringToObject(astro,name,s);
        };
        stamp("astronomical_dawn",record.astronomy.dawn); stamp("astronomical_dusk",record.astronomy.dusk);
    }
    if (record.format == 2) {
        auto schedule = cJSON_AddObjectToObject(root, "station_schedule");
        cJSON_AddNumberToObject(schedule, "normal_interval_seconds", record.normalPeriod);
        cJSON_AddNumberToObject(schedule, "applied_interval_seconds", record.appliedPeriod);
        cJSON_AddNumberToObject(schedule, "revision", record.configRevision);
        const char* reasons[] = {"unknown", "default_setting", "manual_setting", "emergency_voltage", "battery_unavailable"};
        cJSON_AddStringToObject(schedule, "reason", reasons[record.scheduleReason <= 4 ? record.scheduleReason : 0]);
    }
    cJSON* values = cJSON_AddObjectToObject(root, "values");
    const char* names[] = {"air_temperature", "humidity", "pressure", "battery_voltage"};
    const float data[] = {record.temperature, record.humidity, record.pressure, record.battery};
    for (int i = 0; i < 4; ++i) {
        if (std::isfinite(data[i])) cJSON_AddNumberToObject(values, names[i], data[i]);
        else cJSON_AddNullToObject(values, names[i]);
    }
    return root;
}
