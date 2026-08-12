#include "network_manager.h"

#include <ArduinoOTA.h>
#include <WiFi.h>

#include "firmware_config.h"

namespace {

network_manager::Credentials activeCredentials{};
bool timeReady = false;
bool otaReady = false;
volatile bool otaActive = false;
wifi_ps_type_t otaPreviousSleepMode = WIFI_PS_MIN_MODEM;
bool previousWiFiConnected = false;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastNtpRequestMs = 0;
bool ntpRequestActive = false;

bool connectWiFi(uint32_t timeoutMs = 20000UL) {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.printf("Wi-Fi connecting to %s", activeCredentials.wifiSsid);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(activeCredentials.wifiSsid, activeCredentials.wifiPassword);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) {
    Serial.print('.');
    delay(500);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWi-Fi connection timed out.");
    previousWiFiConnected = false;
    return false;
  }
  previousWiFiConnected = true;
  Serial.println("\nWi-Fi connected.");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  Serial.printf("RSSI: %d dBm\n", WiFi.RSSI());
  return true;
}

void maintainWiFi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected) {
    if (!previousWiFiConnected) {
      previousWiFiConnected = true;
      Serial.println("Wi-Fi reconnected.");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
    }
    return;
  }

  if (previousWiFiConnected) {
    previousWiFiConnected = false;
    Serial.println("Wi-Fi disconnected.");
  }

  if (millis() - lastWiFiAttemptMs <
      firmware_config::WIFI_RECONNECT_INTERVAL_MS) return;
  lastWiFiAttemptMs = millis();
  Serial.println("Wi-Fi reconnecting.");
  WiFi.disconnect();
  WiFi.begin(activeCredentials.wifiSsid, activeCredentials.wifiPassword);
}

void requestTimeSync() {
  if (WiFi.status() != WL_CONNECTED) return;
  configTzTime(
    firmware_config::TIMEZONE,
    "pool.ntp.org",
    "time.google.com",
    "time.nist.gov");
  lastNtpRequestMs = millis();
  ntpRequestActive = true;
  Serial.println("NTP synchronization requested (non-blocking).");
}

void maintainTimeSync() {
  time_t now = 0;
  time(&now);
  if (network_manager::isTimeValid(now)) {
    if (!timeReady) {
      Serial.printf("Time synchronized: %s\n",
                    network_manager::formatLocalTime(now).c_str());
    }
    timeReady = true;
    ntpRequestActive = false;
    return;
  }
  timeReady = false;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!ntpRequestActive ||
      millis() - lastNtpRequestMs >= firmware_config::NTP_RETRY_INTERVAL_MS) {
    requestTimeSync();
  }
}

void setupOTA() {
  if (otaReady) return;
  ArduinoOTA.setHostname(activeCredentials.otaHostname);
  ArduinoOTA.setPassword(activeCredentials.otaPassword);
  ArduinoOTA.setTimeout(firmware_config::OTA_RECEIVE_TIMEOUT_MS);
  ArduinoOTA.onStart([]() {
    otaActive = true;
    otaPreviousSleepMode = WiFi.getSleep();
    WiFi.setSleep(WIFI_PS_NONE);
    Serial.println("OTA start; cloud tasks paused and Wi-Fi sleep disabled.");
  });
  ArduinoOTA.onEnd([]() {
    otaActive = false;
    Serial.println("\nOTA completed.");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    unsigned int percent = total > 0
      ? static_cast<unsigned int>((uint64_t)progress * 100ULL / total)
      : 0;
    Serial.printf("OTA progress: %u%%\r", percent);
  });
  ArduinoOTA.onError([](ota_error_t error) {
    otaActive = false;
    WiFi.setSleep(otaPreviousSleepMode);
    Serial.printf("OTA error[%u]; cloud tasks resumed.\n", error);
  });
  ArduinoOTA.begin();
  otaReady = true;
  Serial.printf("OTA ready: %s.local\n", activeCredentials.otaHostname);
}

}  // namespace

namespace network_manager {

void begin(const Credentials& credentials) {
  activeCredentials = credentials;
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    requestTimeSync();
    setupOTA();
  }
}

void maintain() {
  maintainWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainTimeSync();
    setupOTA();
  }
}

void service() {
  if (otaReady) ArduinoOTA.handle();
  delay(1);
}

void servicedDelay(uint32_t milliseconds) {
  uint32_t started = millis();
  while (millis() - started < milliseconds) {
    service();
    delay(5);
  }
}

bool otaInProgress() {
  return otaActive;
}

bool isTimeValid(time_t value) {
  return value >= static_cast<time_t>(firmware_config::VALID_EPOCH_MIN) &&
         static_cast<uint64_t>(value) <= UINT32_MAX;
}

void refreshCurrentTime(time_t& value) {
  time(&value);
  if (!isTimeValid(value)) maintainTimeSync();
  time(&value);
}

String formatLocalTime(time_t value) {
  if (!isTimeValid(value)) return String("--");
  char buffer[32];
  struct tm localTime{};
  localtime_r(&value, &localTime);
  strftime(buffer, sizeof(buffer), "%Y-%m-%d %H:%M:%S", &localTime);
  return String(buffer);
}

int rssi() {
  return WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
}

}  // namespace network_manager
