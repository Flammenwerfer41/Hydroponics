#pragma once
#include <stdint.h>

namespace experiment {
constexpr int maxSteps = 8, maxSamples = 600, maxDurationMs = 60000;
constexpr int chunkSize = 100, maxUploadAttempts = 18;
constexpr int ordinaryUploadChunks = 2;
constexpr int immediateUploadChunks = (maxSamples + chunkSize - 1) / chunkSize;
constexpr int immediateUploadSeconds = 30, minImmediateWindowSeconds = 8;
constexpr int immediateConnectMs = 8000;
constexpr int startMv = 3500, abortMv = 3400;
constexpr int immediateWindowSeconds(int64_t secondsUntilNextSlot) {
    // Leave one second before the next ordinary observation.
    const auto available = secondsUntilNextSlot - 1;
    return available < minImmediateWindowSeconds ? 0
        : available > immediateUploadSeconds ? immediateUploadSeconds : int(available);
}
static_assert(immediateUploadChunks == 6 && immediateUploadChunks <= maxUploadAttempts);
static_assert(immediateWindowSeconds(300) == 30 && immediateWindowSeconds(24) == 23);
static_assert(immediateWindowSeconds(8) == 0 && immediateWindowSeconds(9) == 8);
struct VoltageGuard {
    int recent[8]={}, count=0, at=0, invalid=0, meanMv=-1;
    constexpr int observe(bool valid,int mv) {
        if (!valid) { if (++invalid>=8) { meanMv=-1; return 2; } return 0; }
        invalid=0; recent[at++%8]=mv; if (count<8) ++count;
        int sum=0; for (int i=0;i<count;++i) sum+=recent[i];
        meanMv=sum/count;
        return count==8 && sum<abortMv*8 ? 1 : 0;
    }
};
constexpr bool protectionChecks() {
    VoltageGuard low,invalid,threshold;
    for (int i=0;i<7;++i) if (low.observe(true,3300) || invalid.observe(false,0)) return false;
    if (low.observe(true,3300)!=1 || invalid.observe(false,0)!=2 || invalid.meanMv!=-1) return false;
    for (int i=0;i<20;++i) if (threshold.observe(true,3400)) return false;
    if (threshold.observe(true,3390)!=1) return false;
    VoltageGuard noisy;
    for (int i=0;i<8;++i) noisy.observe(true,3600);
    return !noisy.observe(true,2500) && noisy.meanMv>abortMv;
}
static_assert(protectionChecks());
enum class Action : uint8_t { idle, cpu, wifiConnect, probe, wifiStop, bmeMeasure };
constexpr int bmeRepeatMs=130, bmeMinRemainingMs=30;
struct Step { Action action{}; uint32_t durationMs = 0; };
constexpr bool validInterval(int ms) { return ms >= 20 && ms <= 1000 && ms % 10 == 0; }
constexpr bool validSteps(const Step* steps, int count, int interval) {
    if (count < 1 || count > maxSteps || !validInterval(interval)) return false;
    int total = 0, connects = 0, probes = 0, bmeSteps = 0;
    bool radio = false;
    for (int i=0; i<count; ++i) {
        const auto s = steps[i];
        if (s.durationMs < 100 || s.durationMs > 15000) return false;
        total += s.durationMs;
        switch (s.action) {
            case Action::wifiConnect: if (radio || ++connects > 1 || s.durationMs < 1000) return false; radio=true; break;
            case Action::probe: if (!radio || ++probes > 1 || s.durationMs < 1000) return false; break;
            case Action::wifiStop: if (!radio) return false; radio=false; break;
            case Action::bmeMeasure: if (radio || ++bmeSteps>1 || s.durationMs<1000) return false; break;
            case Action::idle: case Action::cpu: break;
            default: return false;
        }
    }
    // Extra capacity allows scheduling boundaries; late samples are never fabricated.
    return !radio && total <= maxDurationMs && (total+interval-1)/interval+count+2 <= maxSamples;
}
constexpr Step example[] = {{Action::idle,2000},{Action::cpu,2000},{Action::wifiConnect,4000},
    {Action::probe,2000},{Action::wifiStop,100},{Action::idle,3000}};
static_assert(validSteps(example,6,50));
static_assert(!validSteps(example,6,20));
constexpr Step bmeExample[]={{Action::idle,2000},{Action::bmeMeasure,7000},{Action::idle,2000}};
constexpr Step bmeWithRadio[]={{Action::wifiConnect,3000},{Action::bmeMeasure,3000},{Action::wifiStop,100}};
constexpr Step bmeRepeated[]={{Action::bmeMeasure,1000},{Action::bmeMeasure,1000}};
static_assert(validSteps(bmeExample,3,20) && !validSteps(bmeWithRadio,3,20) && !validSteps(bmeRepeated,2,20));
constexpr Step badProbe[] = {{Action::probe,1000}};
static_assert(!validSteps(badProbe,1,100));
constexpr Step shortRun[] = {{Action::idle,1000}};
static_assert(validSteps(shortRun,1,20) && !validSteps(shortRun,1,19));
}
