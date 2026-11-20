#include "station.h"
#include <algorithm>
#include <cstring>
#include <ctime>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_sntp.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

static EventGroupHandle_t wifiEvents;
static bool started;
static bool radioRunning;
static void wifiEvent(void*, esp_event_base_t base, int32_t event, void*) {
    if (base == IP_EVENT && event == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(wifiEvents, 1);
    if (base == WIFI_EVENT && event == WIFI_EVENT_STA_DISCONNECTED) xEventGroupClearBits(wifiEvents, 1);
}
bool connectWifi(int64_t deadline, int maxAttempts, WifiConnectFailure* failure) {
    if (failure) *failure = WifiConnectFailure::Other;
    if (!strlen(STATION_WIFI_SSID) || strlen(STATION_WIFI_SSID) > 32 || strlen(STATION_WIFI_PASSWORD) > 64)
        return false;
    if (!started) {
        if (esp_netif_init() != ESP_OK || esp_event_loop_create_default() != ESP_OK) return false;
        esp_netif_create_default_wifi_sta();
        wifiEvents = xEventGroupCreate();
        wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
        if (!wifiEvents || esp_wifi_init(&init) != ESP_OK) return false;
        esp_wifi_set_storage(WIFI_STORAGE_RAM);
        esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifiEvent, nullptr);
        esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, wifiEvent, nullptr);
        wifi_config_t config{};
        memcpy(config.sta.ssid, STATION_WIFI_SSID, strlen(STATION_WIFI_SSID));
        memcpy(config.sta.password, STATION_WIFI_PASSWORD, strlen(STATION_WIFI_PASSWORD));
        esp_wifi_set_mode(WIFI_MODE_STA);
        esp_wifi_set_config(WIFI_IF_STA, &config);
        started = true;
    }
    if (!radioRunning) {
        xEventGroupClearBits(wifiEvents, 1);
        if (esp_wifi_start() != ESP_OK) {
            if (failure) *failure = WifiConnectFailure::Start;
            return false;
        }
        radioRunning = true;
    }
    if (xEventGroupGetBits(wifiEvents) & 1) return true;
    for (int i = 0; i < std::min(2,maxAttempts) && monotonicMs() < deadline; ++i) {
        const auto result = esp_wifi_connect();
        if (failure && result != ESP_OK) {
            *failure = WifiConnectFailure::Connect;
            return false;
        }
        const int wait = std::min<int64_t>(8000, deadline - monotonicMs());
        if (wait > 0 && (xEventGroupWaitBits(wifiEvents, 1, pdFALSE, pdFALSE, pdMS_TO_TICKS(wait)) & 1)) return true;
        esp_wifi_disconnect();
        if (failure) *failure = WifiConnectFailure::IpTimeout;
    }
    return false;
}
void stopWifi() {
    if (radioRunning) {
        esp_wifi_disconnect();
        esp_wifi_stop();
        radioRunning = false;
        xEventGroupClearBits(wifiEvents, 1);
    }
}
bool syncClock(int64_t deadline) {
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "time.cloudflare.com");
    esp_sntp_init();
    // IDF consumes COMPLETED when it is read; a second read returns RESET.
    bool synced = false;
    while (monotonicMs() < deadline) {
        if (esp_sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED) {
            synced = true;
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    esp_sntp_stop();
    return synced;
}

cJSON* postJson(const char* path, const cJSON* payload, int64_t deadline, int& status) {
    status = 0;
    if (strncmp(STATION_SERVER, "https://", 8) || !strlen(STATION_DEVICE_TOKEN) || monotonicMs() >= deadline)
        return nullptr;
    std::string url = std::string(STATION_SERVER) + path;
    std::string auth = std::string("Bearer ") + STATION_DEVICE_TOKEN;
    char* json = cJSON_PrintUnformatted(payload);
    if (!json) return nullptr;
    esp_http_client_config_t config{};
    config.url = url.c_str();
    config.crt_bundle_attach = esp_crt_bundle_attach;
    config.timeout_ms = std::min<int64_t>(6000, deadline - monotonicMs());
    config.disable_auto_redirect = true;
    auto client = esp_http_client_init(&config);
    if (!client) { cJSON_free(json); return nullptr; }
    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Authorization", auth.c_str());
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Station-Protocol", "1");
    std::string response;
    bool ok = esp_http_client_open(client, strlen(json)) == ESP_OK;
    if (ok) ok = esp_http_client_write(client, json, strlen(json)) == (int)strlen(json);
    cJSON_free(json);
    if (ok && monotonicMs() < deadline) {
        auto length = esp_http_client_fetch_headers(client);
        status = esp_http_client_get_status_code(client);
        if (length > 8192 || length < 0 || status < 200 || status >= 300) ok = false;
    } else ok = false;
    char buffer[512];
    while (ok && monotonicMs() < deadline) {
        int count = esp_http_client_read(client, buffer, sizeof(buffer));
        if (count < 0) { ok = false; break; }
        if (!count) { ok = esp_http_client_is_complete_data_received(client); break; }
        response.append(buffer, count);
        if (response.size() > 8192) { ok = false; break; }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return ok && monotonicMs() < deadline ? cJSON_Parse(response.c_str()) : nullptr;
}
