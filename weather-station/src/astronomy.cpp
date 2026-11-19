#include "station.h"
#include "nvs.h"
#include "esp_log.h"
#include "esp_attr.h"

// Retained through deep sleep, initialized again on cold boot.
RTC_DATA_ATTR static solar::DayCache dayCache{};

void annotateAstronomy(Record& record) {
    // Only scheduled observations call this. OTA voltage probes never consume a closing slot.
    if (!record.epoch || !validClock()) return;
    record.astronomy=solar::calculate(record.epoch,dayCache);
    nvs_handle_t state;
    if (nvs_open("station",NVS_READWRITE,&state)!=ESP_OK) return;
    int64_t day=0;
    auto result=nvs_get_i64(state,"night_day",&day);
    nvs_close(state);
    if (result!=ESP_OK && result!=ESP_ERR_NVS_NOT_FOUND) return;
    // Missing voltage still marks the first observation; do not cherry-pick a later higher voltage.
    record.astronomy.closing=solar::closingCandidate(record.epoch,record.astronomy,record.appliedPeriod,day);
}
void commitNightClosing(const Record& record) {
    if (!record.astronomy.closing) return;
    nvs_handle_t state;
    if (nvs_open("station",NVS_READWRITE,&state)!=ESP_OK) return;
    const bool ok=nvs_set_i64(state,"night_day",solar::jstMidnight(record.epoch))==ESP_OK && nvs_commit(state)==ESP_OK;
    nvs_close(state);
    if (!ok) ESP_LOGW("weather","Night marker not persisted; server keeps earliest closing observation per day");
}
