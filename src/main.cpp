/*
  ESP32 + BME280 Hydroponics Environment Logger v8.4.0
  --------------------------------------------------
  Cloudflare-native release. Physical sensor values are sent to the Cloudflare
  ingestion API. ArduinoOTA and the 14-day LittleFS sensor ring remain available,
  while the ESP-hosted dashboard and HTTP API stay removed to reduce firmware
  size and runtime memory use.

  Each ring record carries a stable boot/sequence identity, all available sensor
  telemetry and a Cloudflare acknowledgement flag. SwitchBot observation and
  control are owned by the Cloudflare Worker.
*/

#include <Arduino.h>
#include "secrets.h"
#include "cloud_upload.h"
#include "measurement_controller.h"
#include "network_manager.h"
#include "ring_storage.h"
#include "sensor_manager.h"

#ifndef CLOUDFLARE_INGEST_URL
#define CLOUDFLARE_INGEST_URL \
  "https://hydroponics-jma-weather.flammenwerfer41.workers.dev/v1/readings"
#endif

#ifndef CLOUDFLARE_DEVICE_TOKEN
#define CLOUDFLARE_DEVICE_TOKEN ""
#endif

// ================= SETUP / LOOP =================
void setup() {
  Serial.begin(115200);
  delay(800);
  measurement_controller::begin();

  sensors::begin(network_manager::servicedDelay);
  network_manager::begin({
    WIFI_SSID,
    WIFI_PASSWORD,
    OTA_HOSTNAME,
    OTA_PASSWORD
  });

  ring_storage::begin(network_manager::service);
  cloud_upload::configure(CLOUDFLARE_INGEST_URL, CLOUDFLARE_DEVICE_TOKEN);
  Serial.printf("Cloudflare ingestion: %s\n",
                cloud_upload::configured()
                  ? "configured"
                  : "disabled (device token missing)");
  Serial.printf("Free heap before tasks: %u bytes\n", ESP.getFreeHeap());

  cloud_upload::begin(network_manager::otaInProgress);
  Serial.println("Setup complete.");
}

void loop() {
  network_manager::maintain();
  network_manager::service();
  measurement_controller::maintain();

  delay(5);
}
