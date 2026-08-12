#pragma once

#include <Arduino.h>
#include <time.h>

namespace network_manager {

struct Credentials {
  const char* wifiSsid;
  const char* wifiPassword;
  const char* otaHostname;
  const char* otaPassword;
};

void begin(const Credentials& credentials);
void maintain();
void service();
void servicedDelay(uint32_t milliseconds);

bool otaInProgress();
bool isTimeValid(time_t value);
void refreshCurrentTime(time_t& value);
String formatLocalTime(time_t value);
int rssi();

}  // namespace network_manager
