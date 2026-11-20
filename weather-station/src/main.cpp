#include "station.h"
#include "experiment.h"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <ctime>
#include "esp_timer.h"
#include "esp_sleep.h"
#include "esp_wifi.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static std::atomic<int64_t> hardDeadline;
static std::atomic<int64_t> lastStoredEpoch{0};
RTC_DATA_ATTR static int64_t lastSync = 0;
RTC_DATA_ATTR static int64_t lastSyncAttempt = 0;
static const char* TAG = "weather";
int64_t monotonicMs() { return esp_timer_get_time() / 1000; }
bool validClock() { return lastSync > 1700000000 && time(nullptr) >= lastSync && time(nullptr) - lastSync < 30 * 86400; }
void setHardDeadline(int seconds) { hardDeadline.store(monotonicMs() + seconds * 1000LL); }
static void recordClockSync() { lastSyncAttempt = lastSync = time(nullptr); }
static int64_t nextMeasurementSlot(int64_t now) {
    return policy::nextObservationSlot(now, activePeriod(), lastStoredEpoch.load());
}
[[noreturn]] void sleepUntilSlot() {
    const auto now = time(nullptr);
    int64_t seconds = validClock() ? nextMeasurementSlot(now) - now : activePeriod();
    if (seconds < 1) seconds = 1;
    ESP_LOGI(TAG, "Deep sleep for %lld seconds; clock=%s", (long long)seconds,
             validClock() ? "synced" : "not_synced");
    // Radio shuts down in deep sleep; no unbounded network teardown is required.
    esp_sleep_enable_timer_wakeup(seconds * 1000000ULL);
    esp_deep_sleep_start();
    __builtin_unreachable();
}
static void deadlineGuard(void*) {
    for (;;) {
        if (monotonicMs() >= hardDeadline.load()) sleepUntilSlot();
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}
static const char* text(const cJSON* obj, const char* name) {
    auto value = cJSON_GetObjectItemCaseSensitive(obj, name);
    return cJSON_IsString(value) ? value->valuestring : "";
}
static cJSON* statusRequest(bool maintenance) {
    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "firmware_version", esp_app_get_description()->version);
    cJSON_AddStringToObject(body, "mode", emergencyMode() ? "emergency" : maintenance ? "maintenance" : "normal");
    scheduleStatus(body);
    experiment::status(body);
    cJSON_AddNumberToObject(body, "queued", queued());
    cJSON_AddNumberToObject(body, "dropped", dropped());
    RetryState retry{};
    if (loadRetry(retry)) {
        cJSON_AddStringToObject(body, "ota_sha256", retry.hash);
        cJSON_AddNumberToObject(body, "ota_attempts", retry.attempts);
        cJSON_AddNumberToObject(body, "ota_next_attempt", retry.next);
    }
    return body;
}
static cJSON* flush(int64_t deadline, bool maintenance = false) {
    cJSON* latestControl = nullptr;
    int failures = 0;
    for (int sent = 0; sent < (emergencyMode() ? 1 : policy::backlogPerWake) && monotonicMs() < deadline;) {
        Record record{};
        if (!oldest(record)) break;
        cJSON* payload = recordJson(record);
        if (sent == 0) cJSON_AddItemToObject(payload, "station_status", statusRequest(maintenance));
        int status;
        cJSON* response = postJson("/v1/readings", payload, deadline, status);
        cJSON_Delete(payload);
        const char* outcome = text(response, "status");
        char expected[48]; snprintf(expected, sizeof(expected), "%s:%lu", record.identity, (unsigned long)record.sequence);
        bool ack = status >= 200 && status < 300 && !strcmp(text(response, "reading_id"), expected) &&
                   (!strcmp(outcome, "accepted") || !strcmp(outcome, "duplicate"));
        if (response) {
            auto control = cJSON_GetObjectItemCaseSensitive(response, "station_control");
            if (cJSON_IsObject(control)) { cJSON_Delete(latestControl); latestControl = cJSON_Duplicate(control, true); }
        }
        cJSON_Delete(response);
        if (ack) { if (!dequeue()) break; ++sent; continue; }
        // Authentication/validation/conflict errors need intervention, not an immediate retry.
        if ((status >= 400 && status < 500) || ++failures >= policy::httpAttempts) break;
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    return latestControl;
}
static int64_t maintenanceUntil(const cJSON* control, int64_t existing) {
    if (emergencyMode()) return 0;
    auto maintenance = cJSON_GetObjectItemCaseSensitive(control, "maintenance");
    if (!cJSON_IsObject(maintenance)) return 0;
    if (consumeMaintenance(text(maintenance, "id")))
        return monotonicMs() + policy::maintenanceSeconds * 1000LL;
    return existing;
}
extern "C" void app_main() {
    setHardDeadline(policy::normalSeconds);
    // Keep network names/credentials out of commissioning logs.
    esp_log_level_set("wifi", ESP_LOG_WARN);
    ESP_LOGI(TAG, "Firmware %s; reset wake=%d; cloud=%s; signed_ota=%s",
             esp_app_get_description()->version, (int)esp_sleep_get_wakeup_cause(),
             strlen(STATION_DEVICE_TOKEN) ? "configured" : "not_configured",
             strlen(STATION_OTA_PUBLIC_KEY) ? "configured" : "not_configured");
    if (xTaskCreate(deadlineGuard, "deadline", 3072, nullptr, 8, nullptr) != pdPASS) sleepUntilSlot();
    if (!initStorage()) { ESP_LOGE(TAG, "Storage unavailable; records were NOT erased"); sleepUntilSlot(); }
    if (!initSchedule()) { ESP_LOGE(TAG, "Schedule storage unavailable"); sleepUntilSlot(); }
    bool sensorReady = initSensors(); // Missing BME280 must not suppress battery records or trigger rollback.
    ESP_LOGI(TAG, "BME280=%s; SDA=19 SCL=20; battery ADC0", sensorReady ? "ready" : "unavailable");
    if (!experiment::init()) ESP_LOGW(TAG,"Experiment storage unavailable; ordinary observations continue");
    if (experiment::runPending()) sleepUntilSlot();
    Record record = measure();
    if (!observeBattery(record.battery, true)) sleepUntilSlot();
    const int wakeSeconds = emergencyMode() ? 20 : policy::normalSeconds;
    setHardDeadline(wakeSeconds);
    int64_t normalDeadline = monotonicMs() + (wakeSeconds - 2) * 1000;
    bool connected = false;
    bool wifiAttempted = false;
    if (!validClock()) {
        wifiAttempted = true;
        connected = connectWifi(std::min<int64_t>(normalDeadline, monotonicMs() + 16000));
        if (connected && syncClock(std::min<int64_t>(normalDeadline, monotonicMs() + 6000))) {
            recordClockSync();
            // Cold boot: do not assign an invented timestamp to a pre-sync observation.
            record = measure();
        }
    }
    if (!observeBattery(record.battery, false)) sleepUntilSlot();
    annotateSchedule(record);
    annotateAstronomy(record);
    bool stored = record.epoch && enqueue(record);
    if (stored) {
        lastStoredEpoch.store(record.epoch);
        commitNightClosing(record);
    }
    ESP_LOGI(TAG, "Observation epoch=%lld temp=%.2fC humidity=%.2f%% pressure=%.2fhPa battery=%.3fV; stored=%d queued=%d",
             (long long)record.epoch, record.temperature, record.humidity, record.pressure,
             record.battery, stored, queued());
    // Local self-test only: transient Wi-Fi, server or sensor outages are not firmware failure.
    // Queue/NVS integrity must work before accepting a pending OTA image.
    esp_ota_img_states_t imageState;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &imageState) == ESP_OK &&
        imageState == ESP_OTA_IMG_PENDING_VERIFY) {
        RetryState check{};
        if (!loadRetry(check) || (record.epoch && !stored)) esp_ota_mark_app_invalid_rollback_and_reboot();
        esp_ota_mark_app_valid_cancel_rollback();
    }
    if (!connected && !wifiAttempted) connected = connectWifi(std::min<int64_t>(normalDeadline, monotonicMs() + 16000));
    ESP_LOGI(TAG, "Wi-Fi=%s; time=%s", connected ? "connected" : "unavailable", validClock() ? "synced" : "not_synced");
    if (!connected) sleepUntilSlot();
    // Sample under radio load before allowing maintenance or firmware writing.
    if (!observeBattery(measure().battery, false)) sleepUntilSlot();
    if (emergencyMode()) {
        normalDeadline = std::min<int64_t>(normalDeadline, monotonicMs() + 7000);
        setHardDeadline(std::max<int64_t>(1, (normalDeadline - monotonicMs()) / 1000 + 1));
    }
    cJSON* control = validClock() ? flush(normalDeadline) : nullptr;
    // One status request reports version/retry state; during maintenance this doubles as control polling.
    if (!control && monotonicMs() + 2000 < normalDeadline) {
        int code; auto body = statusRequest(false);
        auto response = postJson("/v1/station/status", body, normalDeadline, code);
        cJSON_Delete(body);
        if (response) {
            auto updated = cJSON_GetObjectItemCaseSensitive(response, "station_control");
            if (cJSON_IsObject(updated)) { cJSON_Delete(control); control = cJSON_Duplicate(updated, true); }
        }
        cJSON_Delete(response);
    }
    const auto now = time(nullptr);
    if (validClock() && policy::clockSyncDue(now, lastSync, lastSyncAttempt) &&
        monotonicMs() + policy::clockSyncTimeoutMs + 1000 < normalDeadline) {
        // Give ordinary telemetry priority; never wake solely for SNTP.
        // Remember failures across deep sleep so a time-server outage does not add a wait every wake.
        lastSyncAttempt = now;
        const bool synced = syncClock(monotonicMs() + policy::clockSyncTimeoutMs);
        if (synced) recordClockSync();
        ESP_LOGI(TAG, "Hourly SNTP: %s", synced ? "synchronized" : "timed out; keeping RTC time");
    }
    const bool changed = applySchedule(control);
    experiment::accept(control);
    int64_t maintenance = experiment::busy() ? 0 : maintenanceUntil(control, 0);
    if (!experiment::busy()) tryOta(cJSON_GetObjectItemCaseSensitive(control, "update"), batteryAverage());
    cJSON_Delete(control);
    experiment::upload(normalDeadline);
    // Acknowledge persisted configuration in this wake if time permits; otherwise next wake.
    if (changed && monotonicMs() + 2000 < normalDeadline) {
        int code; auto body = statusRequest(false);
        auto response = postJson("/v1/station/status", body, normalDeadline, code);
        cJSON_Delete(body); cJSON_Delete(response);
    }
    int64_t nextMeasurement = validClock() ? nextMeasurementSlot(time(nullptr)) : 0;
    while (maintenance > monotonicMs()) {
        setHardDeadline(std::max<int64_t>(1, (maintenance - monotonicMs()) / 1000));
        if (validClock() && time(nullptr) >= nextMeasurement) {
            record = measure();
            if (!observeBattery(record.battery, false)) sleepUntilSlot();
            annotateSchedule(record); annotateAstronomy(record);
            if (enqueue(record)) {
                lastStoredEpoch.store(record.epoch);
                commitNightClosing(record);
            }
            if (emergencyMode()) sleepUntilSlot();
            nextMeasurement = nextMeasurementSlot(time(nullptr));
            auto updated = flush(std::min<int64_t>(maintenance, monotonicMs() + 15000), true);
            if (applySchedule(updated)) nextMeasurement = nextMeasurementSlot(time(nullptr));
            cJSON_Delete(updated);
        }
        int code; auto body = statusRequest(true);
        auto response = postJson("/v1/station/status", body, std::min<int64_t>(maintenance, monotonicMs() + 8000), code);
        cJSON_Delete(body);
        if (response) {
            auto updated = cJSON_GetObjectItemCaseSensitive(response, "station_control");
            if (applySchedule(updated)) nextMeasurement = validClock() ? nextMeasurementSlot(time(nullptr)) : 0;
            if (!observeBattery(measure().battery, false)) sleepUntilSlot();
            maintenance = maintenanceUntil(updated, maintenance);
            auto update = cJSON_GetObjectItemCaseSensitive(updated, "update");
            if (cJSON_IsObject(update)) tryOta(update, measure().battery);
        }
        cJSON_Delete(response);
        if (emergencyMode()) sleepUntilSlot();
        // Wake the main loop at the measurement boundary even between 30-second polls.
        int delay = 30;
        if (validClock()) delay = std::min<int64_t>(delay, std::max<int64_t>(1, nextMeasurement - time(nullptr)));
        vTaskDelay(pdMS_TO_TICKS(delay * 1000));
    }
    sleepUntilSlot();
}
