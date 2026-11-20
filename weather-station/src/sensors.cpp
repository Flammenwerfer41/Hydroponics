#include "station.h"
#include <cmath>
#include <cstring>
#include <ctime>
#include "driver/i2c.h"
#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_app_desc.h"
#include "esp_random.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bme280.h"

static bme280_dev sensor{};
static uint8_t address;
static bool sensorReady = false;
static adc_oneshot_unit_handle_t adc;
static adc_cali_handle_t calibration;
static char bootIdentity[33] = {};
static uint32_t sequence = 0;

static int8_t readRegister(uint8_t reg, uint8_t* data, uint32_t length, void*) {
    return i2c_master_write_read_device(I2C_NUM_0, address, &reg, 1, data, length,
                                      pdMS_TO_TICKS(100)) == ESP_OK ? 0 : -1;
}
static int8_t writeRegister(uint8_t reg, const uint8_t* data, uint32_t length, void*) {
    uint8_t buffer[64];
    if (length > sizeof(buffer) - 1) return -1;
    buffer[0] = reg;
    memcpy(buffer + 1, data, length);
    return i2c_master_write_to_device(I2C_NUM_0, address, buffer, length + 1,
                                     pdMS_TO_TICKS(100)) == ESP_OK ? 0 : -1;
}
static void waitUs(uint32_t us, void*) {
    // Round UP to an RTOS tick, including Bosch's short reset/start-up delay.
    vTaskDelay((us + portTICK_PERIOD_MS * 1000 - 1) / (portTICK_PERIOD_MS * 1000));
}

bool initSensors() {
    gpio_set_direction(GPIO_NUM_15, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_15, 0);
    i2c_config_t config{};
    config.mode = I2C_MODE_MASTER;
    config.sda_io_num = GPIO_NUM_19;
    config.scl_io_num = GPIO_NUM_20;
    config.sda_pullup_en = GPIO_PULLUP_ENABLE;
    config.scl_pullup_en = GPIO_PULLUP_ENABLE;
    config.master.clk_speed = 100000;
    if (i2c_param_config(I2C_NUM_0, &config) == ESP_OK &&
        i2c_driver_install(I2C_NUM_0, config.mode, 0, 0, 0) == ESP_OK) {
        sensor.intf = BME280_I2C_INTF;
        sensor.read = readRegister;
        sensor.write = writeRegister;
        sensor.delay_us = waitUs;
        for (address = 0x76; address <= 0x77; ++address) {
            const int8_t status = bme280_init(&sensor);
            ESP_LOGI("weather", "BME280 probe address=0x%02x result=%d", address, status);
            if (status == BME280_OK) { sensorReady = true; break; }
        }
        if (sensorReady) {
            bme280_settings settings{};
            settings.osr_t = BME280_OVERSAMPLING_1X;
            settings.osr_h = BME280_OVERSAMPLING_1X;
            settings.osr_p = BME280_OVERSAMPLING_1X;
            settings.filter = BME280_FILTER_COEFF_OFF;
            sensorReady = bme280_set_sensor_settings(BME280_SEL_ALL_SETTINGS, &settings,
                                                   &sensor) == BME280_OK;
        }
    }
    adc_oneshot_unit_init_cfg_t unit{};
    unit.unit_id = ADC_UNIT_1;
    if (adc_oneshot_new_unit(&unit, &adc) != ESP_OK) return sensorReady;
    adc_oneshot_chan_cfg_t channel{};
    channel.atten = ADC_ATTEN_DB_12;
    channel.bitwidth = ADC_BITWIDTH_DEFAULT;
    if (adc_oneshot_config_channel(adc, ADC_CHANNEL_0, &channel) != ESP_OK) return sensorReady;
    adc_cali_curve_fitting_config_t cal{};
    cal.unit_id = ADC_UNIT_1;
    cal.chan = ADC_CHANNEL_0;
    cal.atten = ADC_ATTEN_DB_12;
    cal.bitwidth = ADC_BITWIDTH_DEFAULT;
    // Fail to null instead of claiming an uncalibrated ADC voltage is accurate.
    adc_cali_create_scheme_curve_fitting(&cal, &calibration);
    return sensorReady;
}

bool batterySample(int& raw, int& batteryMv) {
    raw = -1; batteryMv = -1;
    int mv;
    if (!adc || !calibration || adc_oneshot_read(adc, ADC_CHANNEL_0, &raw) != ESP_OK ||
        adc_cali_raw_to_voltage(calibration, raw, &mv) != ESP_OK) return false;
    batteryMv = mv * 2;
    return batteryMv >= 2000 && batteryMv <= 4500;
}
float batteryAverage() {
    int sum = 0;
    for (int i = 0; i < 16; ++i) {
        int raw, mv;
        if (!batterySample(raw, mv)) return NAN;
        sum += mv;
    }
    return sum / 16000.0f;
}

bool readEnvironment(EnvironmentReading& reading, EnvironmentPhaseObserver observe, void* context) {
    reading = {NAN, NAN, NAN};
    if (!sensorReady) return false;
    if (observe) observe(1, context);
    if (bme280_set_sensor_mode(BME280_POWERMODE_FORCED, &sensor) != BME280_OK) {
        if (observe) observe(0, context);
        return false;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
    if (observe) observe(2, context);
    bme280_data data{};
    const bool ok = bme280_get_sensor_data(BME280_ALL, &data, &sensor) == BME280_OK;
    if (ok) {
        if (std::isfinite(data.temperature) && data.temperature >= -40 && data.temperature <= 85)
            reading.temperature = data.temperature;
        if (std::isfinite(data.humidity) && data.humidity >= 0 && data.humidity <= 100)
            reading.humidity = data.humidity;
        if (std::isfinite(data.pressure) && data.pressure >= 30000 && data.pressure <= 120000)
            reading.pressure = data.pressure / 100.0;
    }
    if (observe) observe(0, context);
    return ok;
}

Record measure() {
    Record result{};
    result.epoch = validClock() ? time(nullptr) : 0;
    result.temperature = result.humidity = result.pressure = result.battery = NAN;
    if (!bootIdentity[0]) snprintf(bootIdentity, sizeof(bootIdentity), "%08lx%08lx%08lx%08lx",
             (unsigned long)esp_random(), (unsigned long)esp_random(),
             (unsigned long)esp_random(), (unsigned long)esp_random());
    strlcpy(result.identity, bootIdentity, sizeof(result.identity));
    result.sequence = sequence++;
    strlcpy(result.version, esp_app_get_description()->version, sizeof(result.version));
    result.battery = batteryAverage();
    EnvironmentReading readings{};
    readEnvironment(readings);
    result.temperature = readings.temperature;
    result.humidity = readings.humidity;
    result.pressure = readings.pressure;
    return result;
}
