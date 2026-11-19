#pragma once
// Copy to secrets.h (ignored by Git). Never reuse the tower device token.
#define STATION_WIFI_SSID ""
#define STATION_WIFI_PASSWORD ""
#define STATION_SERVER "https://hydroponics-jma-weather.flammenwerfer41.workers.dev"
#define STATION_DEVICE_TOKEN ""
// RSA-2048 public key PEM from the offline release signing tool.
// Empty key disables OTA. The private key MUST NOT be installed on the device.
#define STATION_OTA_PUBLIC_KEY ""
