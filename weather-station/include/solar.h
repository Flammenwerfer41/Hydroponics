#pragma once
#include <cmath>
#include <ctime>
#include <cstdint>
#include <algorithm>

// NOAA fractional-year approximation: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// Approximate Todoroki area, not an exact home coordinate. No coordinates in telemetry.
// Changing location or algorithm requires a NEW model id, never reinterpret archived records.
namespace solar {
constexpr double latitude = 35.61, longitude = 139.65;
constexpr uint16_t model = 1;
constexpr const char* modelName = "noaa-fractional-v1-todoroki";
constexpr double pi = 3.14159265358979323846;
inline double altitude(int64_t epoch) {
    time_t t = epoch; tm utc{}; gmtime_r(&t, &utc);
    const int year = utc.tm_year + 1900;
    const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const double hour = utc.tm_hour + utc.tm_min / 60.0 + utc.tm_sec / 3600.0;
    const double gamma = 2*pi/(leap ? 366 : 365)*(utc.tm_yday+(hour-12)/24);
    const double eq = 229.18*(.000075+.001868*cos(gamma)-.032077*sin(gamma)-.014615*cos(2*gamma)-.040849*sin(2*gamma));
    const double dec = .006918-.399912*cos(gamma)+.070257*sin(gamma)-.006758*cos(2*gamma)+.000907*sin(2*gamma)-.002697*cos(3*gamma)+.00148*sin(3*gamma);
    const double angle = (hour*60+eq+4*longitude)/4-180;
    const double lat = latitude*pi/180;
    const double zenith = sin(lat)*sin(dec)+cos(lat)*cos(dec)*cos(angle*pi/180);
    return asin(std::max(-1.0,std::min(1.0,zenith)))*180/pi;
}
constexpr int64_t jstMidnight(int64_t epoch) { return ((epoch+9*3600)/86400)*86400-9*3600; }
inline int64_t crossing(int64_t begin, int64_t end, bool rising) {
    if ((altitude(begin)>=-18) == (altitude(end)>=-18)) return 0;
    for (int i=0; i<17 && end-begin>1; ++i) {
        const auto mid=(begin+end)/2;
        if ((altitude(mid)>=-18)==rising) end=mid; else begin=mid;
    }
    return end;
}
struct Snapshot {
    uint32_t dawn = 0, dusk = 0;
    int16_t altitudeCenti = 0;
    uint8_t night = 0, closing = 0;
    uint16_t modelId = 0;
};
// RTC-only cache. No flash writes; data format/model/position are all part of validity.
struct DayCache {
    uint32_t magic = 0, modelId = 0;
    int64_t midnight = 0;
    int32_t latitudeMicro = 0, longitudeMicro = 0;
    uint32_t dawn = 0, dusk = 0, checksum = 0;
};
constexpr uint32_t cacheMagic = 0x534F4C31; // SOL1
constexpr int32_t latitudeMicro = int32_t(latitude*1000000+.5);
constexpr int32_t longitudeMicro = int32_t(longitude*1000000+.5);
constexpr uint32_t cacheChecksum(const DayCache& c) {
    uint32_t hash = 2166136261u;
    const uint32_t fields[] = {c.magic,c.modelId,uint32_t(c.midnight),uint32_t(uint64_t(c.midnight)>>32),
        uint32_t(c.latitudeMicro),uint32_t(c.longitudeMicro),c.dawn,c.dusk};
    for (uint32_t value : fields) hash = (hash ^ value)*16777619u;
    return hash;
}
constexpr bool cacheValid(const DayCache& c, int64_t epoch) {
    return c.magic==cacheMagic && c.modelId==model && c.midnight==jstMidnight(epoch) &&
        c.latitudeMicro==latitudeMicro && c.longitudeMicro==longitudeMicro && c.checksum==cacheChecksum(c) &&
        ((c.dawn==0 && c.dusk==0) || (c.dawn>c.midnight && c.dawn<c.midnight+43200 &&
         c.dusk>c.midnight+43200 && c.dusk<=c.midnight+86400));
}
inline Snapshot calculate(int64_t epoch, DayCache& cache) {
    Snapshot out{};
    if (epoch<1700000000 || epoch>4102444800LL) return out;
    if (!cacheValid(cache,epoch)) {
        DayCache next{};
        next.magic=cacheMagic; next.modelId=model; next.midnight=jstMidnight(epoch);
        next.latitudeMicro=latitudeMicro; next.longitudeMicro=longitudeMicro;
        next.dawn=crossing(next.midnight,next.midnight+12*3600,true);
        next.dusk=crossing(next.midnight+12*3600,next.midnight+86400,false);
        if (!next.dawn || !next.dusk) next.dawn=next.dusk=0;
        next.checksum=cacheChecksum(next);
        cache=next;
    }
    out.dawn=cache.dawn;
    out.dusk=cache.dusk;
    if (!out.dawn || !out.dusk) return {};
    const double height=altitude(epoch);
    out.altitudeCenti=int16_t(std::lround(height*100));
    out.night=height < -18; out.modelId=model;
    return out;
}
constexpr bool cacheChecks() {
    const int64_t day=jstMidnight(1794870000);
    DayCache c{cacheMagic,model,day,latitudeMicro,longitudeMicro,uint32_t(day+18000),uint32_t(day+64800),0};
    c.checksum=cacheChecksum(c);
    if (!cacheValid(c,day) || !cacheValid(c,day+86399) || cacheValid(c,day-1) || cacheValid(c,day+86400)) return false;
    c.dusk++; if (cacheValid(c,day)) return false;
    c.checksum=cacheChecksum(c); c.modelId++; c.checksum=cacheChecksum(c);
    if (cacheValid(c,day)) return false;
    c.modelId=model; c.latitudeMicro++; c.checksum=cacheChecksum(c);
    return !cacheValid(c,day) && !cacheValid(DayCache{},day);
}
static_assert(cacheChecks());
inline bool closingCandidate(int64_t epoch, const Snapshot& s, int period, int64_t lastDay) {
    return s.modelId==model && s.night && epoch>=s.dusk && epoch-s.dusk<=period+300 &&
           jstMidnight(epoch)>lastDay;
}
}
