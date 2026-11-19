#include "station.h"
#include <atomic>
#include <cmath>
#include <cstring>
#include "nvs.h"

namespace {
struct Settings { uint32_t format = 1, period = policy::period, revision = 0, emergency = 0, recovery = 0; };
Settings settings;
nvs_handle_t handle;
std::atomic<int> effective{policy::emergencyPeriod}; // safe fallback if initialization fails
bool unavailable = false;
float lastVoltage = NAN;
bool commit(const Settings& next) {
    if (nvs_set_blob(handle, "schedule", &next, sizeof(next)) != ESP_OK || nvs_commit(handle) != ESP_OK) return false;
    settings = next;
    effective.store(policy::selectedPeriod(settings.period, settings.emergency));
    return true;
}
const char* reason() {
    return unavailable ? "battery_unavailable" : settings.emergency ? "emergency_voltage"
        : settings.revision ? "manual_setting" : "default_setting";
}
}
bool initSchedule() {
    if (nvs_open("station", NVS_READWRITE, &handle) != ESP_OK) return false;
    size_t size = sizeof(settings);
    auto error = nvs_get_blob(handle, "schedule", &settings, &size);
    if (error != ESP_ERR_NVS_NOT_FOUND && (error != ESP_OK || size != sizeof(settings))) return false;
    if (settings.format != 1 || !policy::validPeriod(settings.period) || settings.emergency > 1 || settings.recovery > 1) return false;
    effective.store(policy::selectedPeriod(settings.period, settings.emergency));
    return true;
}
bool observeBattery(float voltage, bool newWake) {
    lastVoltage = voltage;
    unavailable = !policy::validVoltage(voltage);
    Settings next = settings;
    auto power = policy::PowerState{bool(settings.emergency), int(settings.recovery)};
    // Intra-wake checks may ENTER emergency but cannot advance the recovery counter.
    if (newWake || unavailable || policy::millivolts(voltage) <= 3300) power = policy::observePower(power, voltage);
    next.emergency = power.emergency; next.recovery = power.recoveryCount;
    if (next.emergency == settings.emergency && next.recovery == settings.recovery) return true;
    effective.store(policy::selectedPeriod(next.period, next.emergency));
    return commit(next);
}
bool applySchedule(const cJSON* control) {
    auto config = cJSON_GetObjectItemCaseSensitive(control, "schedule");
    if (!cJSON_IsObject(config)) return false;
    auto revision = cJSON_GetObjectItemCaseSensitive(config, "revision");
    auto period = cJSON_GetObjectItemCaseSensitive(config, "normal_interval_seconds");
    if (!cJSON_IsNumber(revision) || revision->valuedouble < 1 || revision->valuedouble > 2147483647 ||
        revision->valuedouble != revision->valueint || !cJSON_IsNumber(period) ||
        period->valuedouble != period->valueint || !policy::validPeriod(period->valueint) ||
        revision->valueint <= settings.revision) return false;
    Settings next = settings; next.period = period->valueint; next.revision = revision->valueint;
    return commit(next);
}
int activePeriod() { return effective.load(); }
bool emergencyMode() { return settings.emergency || unavailable; }
void annotateSchedule(Record& record) {
    record.format = 2;
    record.normalPeriod = settings.period; record.appliedPeriod = activePeriod(); record.configRevision = settings.revision;
    record.scheduleReason = unavailable ? 4 : settings.emergency ? 3 : settings.revision ? 2 : 1;
}
void scheduleStatus(cJSON* body) {
    auto obj = cJSON_AddObjectToObject(body, "schedule");
    cJSON_AddNumberToObject(obj, "normal_interval_seconds", settings.period);
    cJSON_AddNumberToObject(obj, "applied_interval_seconds", activePeriod());
    cJSON_AddNumberToObject(obj, "revision", settings.revision);
    cJSON_AddStringToObject(obj, "reason", reason());
    cJSON_AddStringToObject(body, "power_mode", emergencyMode() ? "emergency" : "normal");
    if (policy::validVoltage(lastVoltage)) cJSON_AddNumberToObject(body, "battery_voltage", lastVoltage);
    else cJSON_AddNullToObject(body, "battery_voltage");
    cJSON_AddNumberToObject(body, "automatic_ota_min_voltage", policy::otaMinVoltage);
    cJSON_AddNumberToObject(body, "manual_ota_min_voltage", policy::manualOtaMinVoltage);
}
