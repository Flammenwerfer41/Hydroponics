#pragma once
#include <stdint.h>
#include <string>
#include "cJSON.h"
#include "policy.h"
#include "solar.h"
#if defined(STATION_COMPILE_CHECK)
#include "compilecheck.h"
#elif __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

struct RecordV1 {
    uint32_t format = 1;
    int64_t epoch = 0;
    char identity[33] = {};
    char version[32] = {};
    uint32_t sequence = 0;
    float temperature, humidity, pressure, battery;
};
struct Record : RecordV1 {
    uint32_t normalPeriod = 0, appliedPeriod = 0, configRevision = 0;
    uint32_t scheduleReason = 0; // 0 legacy, 1 default, 2 manual, 3 emergency, 4 battery unavailable
    solar::Snapshot astronomy{};
};
bool initSchedule();
bool observeBattery(float voltage, bool newWake);
bool applySchedule(const cJSON* control);
int activePeriod();
bool emergencyMode();
void annotateSchedule(Record& record);
void scheduleStatus(cJSON* body);
void annotateAstronomy(Record& record);
void commitNightClosing(const Record& record);
struct RetryState {
    char hash[65] = {};
    int attempts = 0;
    int64_t next = 0;
};
int64_t monotonicMs();
bool validClock();
[[noreturn]] void sleepUntilSlot();
void setHardDeadline(int seconds);
bool initSensors();
struct EnvironmentReading { float temperature, humidity, pressure; };
// Observer: 1 while commanding/waiting for forced conversion, 2 while reading/compensating, 0 after.
using EnvironmentPhaseObserver = void (*)(uint16_t phase, void* context);
bool readEnvironment(EnvironmentReading& reading, EnvironmentPhaseObserver observe = nullptr, void* context = nullptr);
// Individual calibrated ADC conversion; no firmware averaging. Not cell OCV.
bool batterySample(int& raw, int& batteryMv);
float batteryAverage();
Record measure();
bool initStorage();
bool enqueue(const Record& record);
bool oldest(Record& record);
bool dequeue();
int queued();
uint32_t dropped();
bool loadRetry(RetryState& state);
bool saveRetry(const RetryState& state);
bool consumeMaintenance(const char* id);
cJSON* recordJson(const Record& record);
enum class WifiConnectFailure { Other, Start, Connect, IpTimeout };
bool connectWifi(int64_t deadline, int maxAttempts = 2, WifiConnectFailure* failure = nullptr);
void stopWifi();
bool syncClock(int64_t deadline);
// No redirects, strict HTTPS validation, bounded response and timeout.
cJSON* postJson(const char* path, const cJSON* payload, int64_t deadline, int& status);
bool tryOta(const cJSON* command, float battery);
