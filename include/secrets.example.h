#pragma once

// Copy this file to secrets.h and replace the placeholder values.
// Never commit include/secrets.h.

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Cloudflare D1 ingestion. The URL is public; the device token is secret.
#define CLOUDFLARE_INGEST_URL \
  "https://hydroponics-jma-weather.flammenwerfer41.workers.dev/v1/readings"
#define CLOUDFLARE_DEVICE_TOKEN ""

const char* OTA_HOSTNAME = "hydroponics-sensor";
const char* OTA_PASSWORD = "YOUR_OTA_PASSWORD";
