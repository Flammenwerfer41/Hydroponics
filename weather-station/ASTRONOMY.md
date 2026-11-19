# Astronomical night and nightly battery closing — v1.2.0

Local implementation only. No D1 migrations, server deployment, signed firmware registration, approval or OTA performed.

## Definition

- Approximate Todoroki reference point: 35.61 N, 139.65 E. Not a surveyed balcony position. This coarse regional constant is in `include/solar.h`; coordinates are not included in observation JSON.
- NOAA fractional-year solar position approximation, model `noaa-fractional-v1-todoroki`.
- Geometric solar-centre altitude < -18 degrees is **night**; >= -18 is **day** for the future power model. This is not a measurement of generation or charging.
- For each JST calendar day, bounded bisection finds the morning/evening -18-degree crossings. Leap-year denominator is 366. The timestamp resolution is one second, but model accuracy is not one second. Local horizon, shading, weather and panel orientation are not modelled.
- Source: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
- Daily dawn/dusk crossings are calculated at the first valid observation of a JST date and cached in RTC memory across deep sleep. Later observations calculate only current solar altitude. Cold boot, a different date (including backwards clock correction), changed model/location, or an invalid checksum causes recalculation. No special midnight wake or flash write is required for this cache. Compile-time tests cover date boundaries, empty/corrupt cache, model and location changes; deep-sleep retention still needs device verification.
- Coordinates/algorithm changes must get a new model identifier; do not silently reinterpret old snapshots.

## Closing observation

The first regular observation at or after evening astronomical dusk is eligible if it is no later than **the applied interval plus five minutes** after dusk (maximum 65 minutes). There is no extra wake or network call. A later observation is not substituted after that window. Missing voltage remains missing; the next higher voltage is not selected instead. Maintenance voltage probes and OTA probes are not regular observations and cannot consume the daily marker.

Firmware queues the observation first, then commits its JST day marker in NVS. It cannot consume the closing marker when enqueue fails. After reboot/power failure, duplicate candidates can occur between these commits; the database keeps the earliest measurement timestamp for that device and date, regardless of reception order. A backwards clock correction does not reopen an already committed day. No fabricated timestamp is used when clock validity is unknown.

The record stores the calculated dawn, dusk, solar altitude, night flag, closing flag and model ID in its queue sidecar. Thus delayed replay does not recompute astronomical times using a later date or algorithm. Original format-1 sensor records remain unchanged, and old sidecars/observations without astronomical data still load. No automatic NVS erase or queue reset is introduced.

The expanded sidecar is 72 bytes (previous 56), original observation 104 bytes in the verified C6 build. The 1344-slot queue and 512 KiB records partition are unchanged. Full-queue writes, NVS garbage collection and brownout recovery still require hardware testing before relying on maximum retention.

## Server and dashboard

- Migration `0015_station_astronomy.sql` adds an optional `readings.astronomy` field and `station_night_closings` (device/JST-date primary key).
- Closing selection is written atomically with the reading. Existing readings without astronomy retain their original canonical hash.
- Late replay can replace the selected closing only with an earlier timestamp; ordinary duplicate retransmission does not change it. The observation voltage, temperature and measurement time are the original sensor record.
- Latest-reading requests scoped to a device and including battery voltage return `night_closing` as an additional field. Lookup is indexed and limited to the requested date/time range, seven days for the weather page. Other existing latest queries do not add this lookup.
- Public records omit device identifiers as before; astronomy metadata contains no coordinates. JSON/CSV exports and SQL backup include the new data.
- The weather page shows date/time, dusk time, lag, raw voltage, temperature and display-only estimated percentage with its battery model version. No SOC is stored on the ESP32 or D1.
- Empty, missing-voltage and old records are explicit. A previous-day closing is dated as such, never called today's closing. HTTP failure leaves the previous display with a stale-query warning.

## Scope / activation

Astronomy is **observational only** in this version: it does not alter the normal/emergency intervals, OTA voltage gates, or battery percentage curve. Future adaptive decision-making stays on-device, consuming this metadata when implemented.

Apply migrations 0014 then 0015 and deploy compatible server/static assets before activating firmware 1.2.0. Build/sign a production release separately; the compilecheck binary uses dummy credentials and must never be installed. Existing firmware still requires its original 3.8 V gate for the first upgrade.

Verified: firmware compilation, Worker dry-run build, server validation/replay/index selection tests and synthetic browser display. Not verified on hardware: first dusk capture, restart/power-loss edge cases, full queue and actual astronomical timing versus a reference instrument.
