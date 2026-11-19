#pragma once
#include <stdint.h>

namespace policy {
constexpr int period = 300; // Temporary balcony commissioning: five-minute wall-clock slots.
constexpr int normalSeconds = 45;
constexpr int httpAttempts = 2;
constexpr int backlogPerWake = 8;
constexpr int maintenanceSeconds = 900;
constexpr int otaSeconds = 120;
constexpr int maxOtaAttempts = 3;
constexpr int queueCapacity = 1344; // ~4.7 days at 288/day; 14 days at the normal 15-minute cadence.
constexpr double otaMinVoltage = 3.6;
constexpr double manualOtaMinVoltage = 3.5;
constexpr double emergencyVoltage = 3.3;
constexpr double recoveryVoltage = 3.5;
constexpr int emergencyPeriod = 3600;
constexpr bool validPeriod(int seconds) {
    return seconds == 300 || seconds == 600 || seconds == 900 || seconds == 1800 || seconds == 3600;
}
constexpr bool validVoltage(double voltage) { return voltage >= 2 && voltage <= 4.5; }
constexpr int millivolts(double voltage) { return validVoltage(voltage) ? int(voltage * 1000 + 0.5) : -1; }
constexpr const char* hardware = "firebeetle2-esp32c6-v1.2";
constexpr int64_t nextSlot(int64_t epoch, int seconds = period) { return (epoch / seconds + 1) * seconds; }
struct PowerState { bool emergency = false; int recoveryCount = 0; };
// Called once per wake, never once per HTTP poll: two separate wakes must confirm recovery.
constexpr PowerState observePower(PowerState state, double voltage) {
    if (!validVoltage(voltage) || millivolts(voltage) <= 3300) return {true, 0};
    if (!state.emergency) return {false, 0};
    if (millivolts(voltage) < 3500) return {true, 0};
    return state.recoveryCount >= 1 ? PowerState{false, 0} : PowerState{true, 1};
}
// Future on-device adaptive controller supplies its candidate here; server config is only a preference.
constexpr int selectedPeriod(int candidate, bool emergency) {
    return emergency ? emergencyPeriod : validPeriod(candidate) ? candidate : period;
}
constexpr int64_t retryDelay(int attempts) {
    return attempts <= 1 ? 3600 : 6 * 3600;
}
constexpr bool otaAllowed(int attempts, int64_t next, int64_t now, double voltage,
                          bool manual = false, bool emergency = false) {
    return attempts >= 0 && attempts < maxOtaAttempts && now >= next &&
           !emergency && validVoltage(voltage) && millivolts(voltage) >= (manual ? 3500 : 3600);
}
constexpr bool parseVersion(const char* text, int (&parts)[3]) {
    for (int i = 0; i < 3; ++i) {
        int digits = 0, value = 0;
        const bool zero = *text == '0';
        while (*text >= '0' && *text <= '9') {
            value = value * 10 + *text++ - '0';
            if (++digits > 4) return false;
        }
        if (!digits || (zero && digits > 1)) return false;
        parts[i] = value;
        if (i < 2 && *text++ != '.') return false;
    }
    return *text == '\0';
}
constexpr bool newerVersion(const char* candidate, const char* current) {
    int a[3]{}, b[3]{};
    if (!parseVersion(candidate, a) || !parseVersion(current, b)) return false;
    for (int i = 0; i < 3; ++i) if (a[i] != b[i]) return a[i] > b[i];
    return false;
}
static_assert(nextSlot(0) == 300 && nextSlot(299) == 300 && nextSlot(300) == 600);
static_assert(nextSlot(3599) == 3600 && nextSlot(3600) == 3900);
static_assert(newerVersion("1.0.1", "1.0.0") && newerVersion("1.10.0", "1.9.0"));
static_assert(!newerVersion("1.0.0", "1.0.0") && !newerVersion("0.9.0", "1.0.0"));
static_assert(!newerVersion("2.0", "1.0.0") && !newerVersion("02.0.0", "1.0.0"));
static_assert(otaAllowed(0, 100, 100, 3.8) && otaAllowed(2, 100, 101, 4.2));
static_assert(!otaAllowed(3, 100, 101, 4.2) && !otaAllowed(0, 100, 99, 4.2));
static_assert(!otaAllowed(0, 0, 100, 3.59) && !otaAllowed(-1, 0, 100, 4.2));
static_assert(otaAllowed(0, 0, 100, 3.5, true) && !otaAllowed(0, 0, 100, 3.49, true));
static_assert(!otaAllowed(0, 0, 100, 4.2, true, true));
static_assert(otaAllowed(0, 0, 100, float(3.6)) && observePower({}, float(3.3)).emergency);
static_assert(observePower({}, 3.3).emergency);
static_assert(observePower({true, 0}, 3.5).emergency);
static_assert(!observePower({true, 1}, 3.5).emergency);
static_assert(observePower({true, 1}, 3.49).recoveryCount == 0);
static_assert(selectedPeriod(300, true) == 3600 && selectedPeriod(600, false) == 600);
static_assert(nextSlot(3599, 600) == 3600 && nextSlot(3600, 3600) == 7200);
static_assert(!otaAllowed(0, 0, 100, 5.0));
static_assert(retryDelay(1) == 3600 && retryDelay(2) == 21600);
constexpr bool schedulingChecks() {
    const int periods[] = {300, 600, 900, 1800, 3600};
    for (int p : periods) {
        for (int64_t epoch : {int64_t(0), int64_t(299), int64_t(86399), int64_t(86400)}) {
            const auto next = nextSlot(epoch, p);
            if (next <= epoch || next - epoch > p || next % p) return false;
        }
        if (selectedPeriod(p, true) != 3600 || selectedPeriod(p, false) != p) return false;
    }
    auto power = observePower({}, 3.2);
    power = observePower(power, 3.5);
    if (!power.emergency || power.recoveryCount != 1) return false;
    power = observePower(power, 3.4);
    if (!power.emergency || power.recoveryCount != 0) return false;
    power = observePower(observePower(power, 3.6), 3.6);
    return !power.emergency && !validPeriod(60) && !validPeriod(0) &&
           !otaAllowed(3, 0, 100, 4.2, true) && !otaAllowed(0, 101, 100, 4.2, true);
}
static_assert(schedulingChecks());
}
