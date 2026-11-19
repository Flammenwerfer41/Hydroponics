# Power and observation scheduling — firmware 1.1.0

Status: implemented locally; not uploaded, signed, approved or deployed. Existing 1.0.x devices retain their previous 3.8 V OTA gate until the first upgrade.

## Device owns the decision

The server supplies only a persistent **normal interval preference**, with an increasing revision. Firmware validates the allowed values (300/600/900/1800/3600 seconds), commits them to NVS, and uses `policy::selectedPeriod(candidate, emergency)` for the effective interval. No server-side adaptive controller or energy prediction is enabled. A future on-device adaptive controller can replace the candidate selection while retaining the local emergency override, storage and status interfaces. Offline operation uses the last committed preference; a missing control response never resets it.

Defaults: normal 300 seconds (existing commissioning setting); emergency 3600 seconds. Sleep aligns to the next wall-clock multiple of the effective interval; without valid clock it sleeps one full interval. Changing the interval requires the next wake/communication; the web interface cannot wake a sleeping radio. Configuration is acknowledged after persistence, in the same wake when time permits or the next report.

## Two operating states

- Enter emergency at battery <=3.3 V, or unavailable/invalid battery measurement.
- Recover only after >=3.5 V on two separate wakes. Intra-wake polls cannot increase the recovery count; a low/unknown reading resets it.
- Normal: bounded 45-second wake, existing retry limits and backlog cap.
- Emergency: 60-minute observation interval, 20-second wake budget, at most one queued observation uploaded per wake, no maintenance or OTA. This is a software conservation policy, not a hardware battery-protection guarantee. Very low battery can still brown out before software runs.
- Recovery state is persisted only when changed, not on every unchanged wake. Other state writes likewise occur only when a new revision is accepted.

Voltage comparisons round to millivolts to avoid float boundary artifacts. These are initial operational thresholds, not manufacturer-validated minimum voltages. Solar charging shifts, temperature, regulator dropout and radio load remain important.

## OTA

- Automatic: >=3.6 V, non-emergency state.
- Explicit administrator request: >=3.5 V, non-emergency state, valid for one hour and tied to the currently approved image.
- Merely entering maintenance never bypasses the battery gate.
- Voltage is checked again with Wi-Fi connected before OTA. Existing signed image validation, hardware/version checks, size/hash verification, 120-second timeout, maximum three attempts, 1h/6h backoff and rollback remain.
- A voltage rejection does not consume a retry. A manual request does not reset retries. Approval/pause clears the manual exception.
- Firmware cannot rescue the older firmware's 3.8 V gate remotely; charge sufficiently or use USB for the first upgrade.

## Recorded metadata and compatibility

Every new observation carries optional `station_schedule` with `normal_interval_seconds`, `applied_interval_seconds`, `revision` and `reason` (`default_setting`, `manual_setting`, `emergency_voltage`, `battery_unavailable`). This describes the decision at measurement time, not the current server preference. Old readings omit this field; they are never relabeled during backlog replay.

The original NVS observation blob remains format 1, with unchanged layout. New scheduling metadata uses a separate sidecar keyed by queue slot and checked against boot identity + sequence. This allows reading old queued data and keeps base observations readable by old firmware. Old firmware does not transmit scheduling metadata. Queue capacity and flash partition layout are unchanged; sidecars increase NVS usage (validate full-queue behavior before relying on maximum offline retention).

Migration `0014_station_schedule.sql` adds optional observation metadata and control fields plus a bounded-index management audit table. Existing canonical payload hashes remain identical for readings without scheduling metadata. Replay with changed metadata is rejected as a conflict. Public raw/latest responses expose only the scheduling metadata in addition to existing public fields; device identities remain omitted. JSON/CSV exports and SQL backup include metadata.

History gaps use the larger adjacent reported interval +5 minutes (legacy fallback 20 minutes); current-value staleness uses twice the reported interval +5 minutes (legacy 35 minutes). These are display-quality rules, not the controller. A setting changed after an observation will be visible in subsequent observation metadata; no claim that the previous observation had the new interval is made.

## Activation order (not performed)

1. Back up D1, apply migration 0014, deploy Worker and static assets together; verify old 1.0.x telemetry still works.
2. Build the production 1.1.0 binary with existing private configuration; sign/register it, then explicitly approve when ready. Compilecheck binaries must never be flashed.
3. Wait for the old 3.8 V gate, confirm reported 1.1.0, test normal-period revision/acknowledgement and restart persistence.
4. Validate low-voltage behavior using a controlled supply rather than deliberately exhausting an unattended outdoor battery. Check watchdog fallback, full queue/NVS, rollback and actual under-load voltage.

No adaptive model, solar current sensing, automatic SOC-based control, or firmware installation is included in this change.
