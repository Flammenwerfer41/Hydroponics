#include "sensor_manager.h"

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <Adafruit_VEML7700.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <SensirionI2cScd4x.h>

#include "firmware_config.h"
#include "telemetry_record.h"

namespace {

constexpr int16_t SCD40_NO_ERROR = 0;

Adafruit_BME280 bme;
Adafruit_VEML7700 veml7700;
SensirionI2cScd4x scd40;
TwoWire secondaryWire(firmware_config::SECONDARY_I2C_BUS_INDEX);
OneWire waterTemperatureBus(firmware_config::WATER_TEMPERATURE_PIN);
DallasTemperature waterTemperatureSensors(&waterTemperatureBus);
DeviceAddress waterTemperatureAddress{};

uint8_t bmeAddress = 0;
bool waterTemperatureSensorReady = false;
bool scd40Ready = false;
bool veml7700Ready = false;
sensors::DelayHandler serviceDelay = nullptr;

TwoWire& i2cBus(uint8_t index) {
  return index == firmware_config::SECONDARY_I2C_BUS_INDEX
    ? secondaryWire
    : Wire;
}

void servicedDelay(uint32_t milliseconds) {
  if (serviceDelay) serviceDelay(milliseconds);
  else delay(milliseconds);
}

bool initializeBME280() {
  TwoWire* bus = &i2cBus(firmware_config::BME280_I2C_BUS_INDEX);
  if (bme.begin(0x76, bus)) bmeAddress = 0x76;
  else if (bme.begin(0x77, bus)) bmeAddress = 0x77;
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

bool initializeSCD40() {
  scd40.begin(
    i2cBus(firmware_config::SCD40_I2C_BUS_INDEX), SCD40_I2C_ADDR_62);
  // stopPeriodicMeasurement also returns the sensor to a known state after a
  // partial I2C failure. A fresh idle sensor can safely continue to start.
  int16_t stopError = scd40.stopPeriodicMeasurement();
  if (stopError == SCD40_NO_ERROR) {
    servicedDelay(firmware_config::SCD40_RESTART_DELAY_MS);
  }
  int16_t error = scd40.startPeriodicMeasurement();
  if (error != SCD40_NO_ERROR) {
    scd40Ready = false;
    Serial.printf("SCD40 initialization failed: error %d.\n", error);
    return false;
  }
  scd40Ready = true;
  Serial.printf("SCD40 periodic measurement started on I2C bus %u.\n",
                firmware_config::SCD40_I2C_BUS_INDEX);
  return true;
}

bool initializeVEML7700() {
  TwoWire* bus = &i2cBus(firmware_config::VEML7700_I2C_BUS_INDEX);
  if (!veml7700.begin(bus)) {
    veml7700Ready = false;
    Serial.println("VEML7700 not found.");
    return false;
  }
  veml7700Ready = true;
  Serial.printf("VEML7700 ready on I2C bus %u.\n",
                firmware_config::VEML7700_I2C_BUS_INDEX);
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
  Wire.begin(
    firmware_config::PRIMARY_I2C_SDA_PIN,
    firmware_config::PRIMARY_I2C_SCL_PIN);
  secondaryWire.begin(
    firmware_config::SECONDARY_I2C_SDA_PIN,
    firmware_config::SECONDARY_I2C_SCL_PIN);
  Serial.printf("Primary I2C bus %u: SDA GPIO %d, SCL GPIO %d (BME280, VEML7700).\n",
                firmware_config::PRIMARY_I2C_BUS_INDEX,
                firmware_config::PRIMARY_I2C_SDA_PIN,
                firmware_config::PRIMARY_I2C_SCL_PIN);
  Serial.printf("Secondary I2C bus %u: SDA GPIO %d, SCL GPIO %d (SCD40).\n",
                firmware_config::SECONDARY_I2C_BUS_INDEX,
                firmware_config::SECONDARY_I2C_SDA_PIN,
                firmware_config::SECONDARY_I2C_SCL_PIN);
  initializeBME280();
  initializeDS18B20();
  initializeSCD40();
  initializeVEML7700();
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

bool readCo2(
    float pressureHpa,
    uint16_t& concentration,
    float& sensorTemperature,
    float& sensorHumidity) {
  concentration = 0;
  sensorTemperature = NAN;
  sensorHumidity = NAN;
  if (!scd40Ready && !initializeSCD40()) return false;

  if (isfinite(pressureHpa)) {
    uint32_t pressurePa = static_cast<uint32_t>(lroundf(pressureHpa * 100.0f));
    if (pressurePa >= 70000UL && pressurePa <= 120000UL) {
      int16_t pressureError = scd40.setAmbientPressure(pressurePa);
      if (pressureError != SCD40_NO_ERROR) {
        Serial.printf("SCD40 pressure compensation failed: error %d.\n",
                      pressureError);
      }
    }
  }

  bool dataReady = false;
  int16_t error = scd40.getDataReadyStatus(dataReady);
  if (error != SCD40_NO_ERROR) {
    scd40Ready = false;
    Serial.printf("SCD40 data-ready check failed: error %d.\n", error);
    return false;
  }
  if (!dataReady) {
    Serial.println("SCD40 measurement is not ready yet.");
    return false;
  }

  error = scd40.readMeasurement(
    concentration, sensorTemperature, sensorHumidity);
  if (error != SCD40_NO_ERROR || !validCo2Measurement(concentration)) {
    if (error != SCD40_NO_ERROR) scd40Ready = false;
    Serial.printf("SCD40 measurement failed: error %d, CO2 %u ppm.\n",
                  error, concentration);
    concentration = 0;
    sensorTemperature = NAN;
    sensorHumidity = NAN;
    return false;
  }
  return true;
}

bool readIlluminance(float& illuminance) {
  illuminance = NAN;
  if (!veml7700Ready && !initializeVEML7700()) return false;
  illuminance = veml7700.readLux(VEML_LUX_AUTO);
  if (validIlluminanceMeasurement(illuminance)) return true;
  veml7700Ready = false;
  illuminance = NAN;
  Serial.println("Invalid VEML7700 illuminance; field is unavailable.");
  return false;
}

void invalidateAir() {
  bmeAddress = 0;
}

void invalidateCo2() {
  scd40Ready = false;
}

void invalidateIlluminance() {
  veml7700Ready = false;
}

}  // namespace sensors
