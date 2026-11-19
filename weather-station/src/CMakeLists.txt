set(bosch_bme280_SOURCE_DIR "${CMAKE_BINARY_DIR}/_deps/bosch_bme280-src")
idf_component_register(SRCS "main.cpp" "sensors.cpp" "storage.cpp" "transport.cpp" "ota.cpp" "schedule.cpp" "astronomy.cpp" "experiment.cpp"
    "${bosch_bme280_SOURCE_DIR}/bme280.c"
    INCLUDE_DIRS "../include" "${bosch_bme280_SOURCE_DIR}"
    REQUIRES driver esp_adc esp_wifi esp_event esp_netif nvs_flash esp_http_client
    app_update mbedtls json esp_timer)
