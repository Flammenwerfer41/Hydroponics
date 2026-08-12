#include "sensor_manager.h"

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#include "firmware_config.h"
#include "telemetry_record.h"

namespace {

Adafruit_BME280 bme;
OneWire waterTemperatureBus(firmware_config::WATER_TEMPERATURE_PIN);
DallasTemperature waterTemperatureSensors(&waterTemperatureBus);
DeviceAddress waterTemperatureAddress{};

uint8_t bmeAddress = 0;
bool waterTemperatureSensorReady = false;
sensors::DelayHandler serviceDelay = nullptr;

bool initializeBME280() {
  if (bme.begin(0x76)) bmeAddress = 0x76;
  else if (bme.begin(0x77)) bmeAddress = 0x77;
  else {
    bmeAddress = 0;
    Serial.println("BME280 not found.");
    return false;
  }
  bme.setSampling(Adafruit_BME280::MODE_FORCED,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::FILTER_X4,
                  Adafruit_BME280::STANDBY_MS_0_5);
  Serial.printf("BME280 ready at 0x%02X\n", bmeAddress);
  return true;
}

bool initializeDS18B20() {
  waterTemperatureSensors.begin();
  if (!waterTemperatureSensors.getAddress(waterTemperatureAddress, 0)) {
    waterTemperatureSensorReady = false;
    Serial.printf("DS18B20 not found on GPIO %d.\n",
                  firmware_config::WATER_TEMPERATURE_PIN);
    return false;
  }
  waterTemperatureSensors.setResolution(
    waterTemperatureAddress, firmware_config::DS18B20_RESOLUTION_BITS);
  waterTemperatureSensors.setWaitForConversion(false);
  waterTemperatureSensorReady = true;
  Serial.printf("DS18B20 ready on GPIO %d at %u-bit resolution.\n",
                firmware_config::WATER_TEMPERATURE_PIN,
                firmware_config::DS18B20_RESOLUTION_BITS);
  return true;
}

}  // namespace

namespace sensors {

void begin(DelayHandler delayHandler) {
  serviceDelay = delayHandler;
  Wire.begin(firmware_config::I2C_SDA_PIN, firmware_config::I2C_SCL_PIN);
  initializeBME280();
  initializeDS18B20();
}

bool readAir(float& temperature, float& humidity, float& pressure) {
  if (bmeAddress == 0 && !initializeBME280()) return false;
  if (!bme.takeForcedMeasurement()) return false;
  temperature = bme.readTemperature();
  humidity = bme.readHumidity();
  pressure = bme.readPressure() / 100.0f;
  return validAirMeasurement(temperature, humidity, pressure);
}

bool readWater(float& temperature) {
  temperature = NAN;
  if (!waterTemperatureSensorReady && !initializeDS18B20()) return false;
  waterTemperatureSensors.requestTemperaturesByAddress(waterTemperatureAddress);
  if (serviceDelay) serviceDelay(firmware_config::DS18B20_CONVERSION_MS);
  else delay(firmware_config::DS18B20_CONVERSION_MS);
  temperature = waterTemperatureSensors.getTempC(waterTemperatureAddress);
  if (validWaterMeasurement(temperature)) return true;
  waterTemperatureSensorReady = false;
  temperature = NAN;
  Serial.println("Invalid DS18B20 water temperature; water field is unavailable.");
  return false;
}

void invalidateAir() {
  bmeAddress = 0;
}

}  // namespace sensors
