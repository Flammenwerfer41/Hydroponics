#include "station.h"
#include <algorithm>
#include <cstring>
#include <ctime>
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_ota_ops.h"
#include "esp_app_format.h"
#include "esp_app_desc.h"
#include "esp_system.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include "mbedtls/base64.h"

static const char* text(const cJSON* obj, const char* key) {
    auto value = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(value) ? value->valuestring : "";
}
bool tryOta(const cJSON* command, float battery) {
    if (!observeBattery(battery, false) || emergencyMode()) return false;
    if (!cJSON_IsObject(command) || !strlen(STATION_OTA_PUBLIC_KEY) || !validClock()) return false;
    const char* hardware = text(command, "hardware");
    const char* version = text(command, "version");
    const char* hash = text(command, "sha256");
    const char* signature = text(command, "signature");
    auto sizeJson = cJSON_GetObjectItemCaseSensitive(command, "size");
    if (strcmp(hardware, policy::hardware) || !strlen(version) || strlen(version) > 31 ||
        !policy::newerVersion(version, esp_app_get_description()->version) || strlen(hash) != 64 ||
        strspn(hash, "0123456789abcdef") != 64 || !cJSON_IsNumber(sizeJson) ||
        sizeJson->valuedouble != sizeJson->valueint || sizeJson->valueint < 512 ||
        sizeJson->valueint > 0x1b0000) return false;
    const int size = sizeJson->valueint;
    std::string message = std::string("weather-ota-v1\n") + hardware + "\n" + version + "\n" +
                          std::to_string(size) + "\n" + hash;
    unsigned char digest[32], signatureBytes[256]; size_t signatureLength = 0;
    mbedtls_sha256((const unsigned char*)message.data(), message.size(), digest, 0);
    if (mbedtls_base64_decode(signatureBytes, sizeof(signatureBytes), &signatureLength,
                             (const unsigned char*)signature, strlen(signature)) || signatureLength != 256)
        return false;
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    bool verified = !mbedtls_pk_parse_public_key(&key, (const unsigned char*)STATION_OTA_PUBLIC_KEY,
                                               strlen(STATION_OTA_PUBLIC_KEY) + 1) &&
                    mbedtls_pk_get_type(&key) == MBEDTLS_PK_RSA && mbedtls_pk_get_bitlen(&key) == 2048 &&
                    !mbedtls_pk_verify(&key, MBEDTLS_MD_SHA256, digest, 32, signatureBytes, signatureLength);
    mbedtls_pk_free(&key);
    if (!verified) return false;
    RetryState retry{};
    if (!loadRetry(retry)) return false;
    if (strcmp(retry.hash, hash)) { retry = {}; strlcpy(retry.hash, hash, sizeof(retry.hash)); }
    const auto now = time(nullptr);
    auto manualUntil = cJSON_GetObjectItemCaseSensitive(command, "manual_until_epoch");
    const bool manual = cJSON_IsNumber(manualUntil) && manualUntil->valuedouble > now &&
                       manualUntil->valuedouble <= now + 3600;
    if (!policy::otaAllowed(retry.attempts, retry.next, now, battery, manual, emergencyMode())) return false;
    ++retry.attempts;
    retry.next = time(nullptr) + policy::retryDelay(retry.attempts);
    // Reserve an attempt BEFORE any network/flash work; brownout must not reset the retry budget.
    if (!saveRetry(retry)) return false;
    setHardDeadline(policy::otaSeconds);
    const int64_t deadline = monotonicMs() + policy::otaSeconds * 1000;
    std::string url = std::string(STATION_SERVER) + "/v1/station/firmware/" + hash;
    std::string auth = std::string("Bearer ") + STATION_DEVICE_TOKEN;
    esp_http_client_config_t config{};
    config.url = url.c_str(); config.crt_bundle_attach = esp_crt_bundle_attach;
    config.timeout_ms = 8000; config.disable_auto_redirect = true;
    auto client = esp_http_client_init(&config);
    if (!client) return false;
    esp_http_client_set_header(client, "Authorization", auth.c_str());
    bool ok = esp_http_client_open(client, 0) == ESP_OK;
    if (ok) ok = esp_http_client_fetch_headers(client) == size && esp_http_client_get_status_code(client) == 200;
    const esp_partition_t* target = esp_ota_get_next_update_partition(nullptr);
    esp_ota_handle_t ota = 0;
    if (ok) ok = target && target->size >= (uint32_t)size && esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &ota) == ESP_OK;
    mbedtls_sha256_context sha; mbedtls_sha256_init(&sha); mbedtls_sha256_starts(&sha, 0);
    uint8_t buffer[4096]; int total = 0;
    while (ok && total < size && monotonicMs() < deadline) {
        int count = esp_http_client_read(client, (char*)buffer, std::min<int>(sizeof(buffer), size - total));
        if (count <= 0) { ok = false; break; }
        if (!total) {
            const size_t offset = sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t);
            // Collect descriptor even if TLS delivers the first chunk in small pieces.
            while (count < (int)(offset + sizeof(esp_app_desc_t)) && monotonicMs() < deadline) {
                int more = esp_http_client_read(client, (char*)buffer + count, offset + sizeof(esp_app_desc_t) - count);
                if (more <= 0) { ok = false; break; }
                count += more;
            }
            if (!ok || count < (int)(offset + sizeof(esp_app_desc_t))) { ok = false; break; }
            esp_app_desc_t desc; memcpy(&desc, buffer + offset, sizeof(desc));
            if (desc.magic_word != ESP_APP_DESC_MAGIC_WORD ||
                strncmp(desc.project_name, "balcony-weather", sizeof(desc.project_name)) ||
                strncmp(desc.version, version, sizeof(desc.version))) { ok = false; break; }
        }
        if (mbedtls_sha256_update(&sha, buffer, count) || esp_ota_write(ota, buffer, count) != ESP_OK) {
            ok = false; break;
        }
        total += count;
    }
    mbedtls_sha256_finish(&sha, digest); mbedtls_sha256_free(&sha);
    char actual[65]; for (int i = 0; i < 32; ++i) snprintf(actual + i * 2, 3, "%02x", digest[i]);
    esp_http_client_close(client); esp_http_client_cleanup(client);
    ok = ok && total == size && monotonicMs() < deadline && !strcmp(actual, hash);
    if (!ok) { if (ota) esp_ota_abort(ota); return false; }
    if (esp_ota_end(ota) != ESP_OK) return false;
    if (esp_ota_set_boot_partition(target) != ESP_OK) return false;
    esp_restart();
    return true;
}
