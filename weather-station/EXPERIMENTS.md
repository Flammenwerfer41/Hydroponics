# Firmware 2.0.0 — bounded voltage experiments

2026-11-19: firmware, server and unified administrator UI implementation.
See `OTA_OPERATIONS.md` for verified deployment and approval status; approval does not prove installation.
The tower firmware is untouched. Existing station 1.1 power/scheduling and 1.2 astronomy features are included.

## Editing and operating from the dashboard

Open `/admin/station/` after Cloudflare Access login. The overview separates the device-reported
version from the approved OTA target. Capability labels indicate version support, not hardware validation.

1. Create a draft with a title and purpose. The default recipe compares idle, CPU load, Wi-Fi connect,
   one HTTPS probe, radio stop and recovery. Advanced JSON remains available for assisted editing.
2. Review the duration, sample bound and step preview, then save. Drafts are never delivered to devices.
3. Explicitly approve the saved revision. The server rejects stale edits, duplicate approvals, old firmware,
   pending OTA/maintenance and busy devices. Approval freezes that draft; clone it to change the experiment.
4. Open a result on demand to view the voltage trace, actual step timings, completeness and outcome.
   Missing chunks/null samples break the line. Download JSON to retain raw ADC and timestamp data.
5. Cancellation is asynchronous: an offline device cannot be stopped remotely. On its next contact the
   instruction can discard local unsent results, while already received server chunks are retained.

No experiment is automatically approved or launched when the dashboard or firmware is deployed.
The local fixture `node scripts/preview-station-v2.mjs` uses synthetic data and never contacts the device.

## What runs on the device

This is a small **declarative state machine**, not a VM, downloaded executable or general-purpose script engine.
Only `idle`, `cpu_load`, `wifi_connect`, `network_probe`, `wifi_stop`, and (from v2.0.4) `bme_measure` are recognized.
To add another kind of action, update the firmware and recipe schema/validators deliberately.

1. A normal observation upload receives a recipe from the authenticated server.
2. The recipe is checked and saved to NVS. No experiment starts during that connection.
3. On the next scheduled wake, before normal BME measurement or Wi-Fi, the device checks time,
   expiry, battery, queue backlog and OTA self-test state. Battery sampling is already initialized.
4. A durable `running` marker is written **before** executing any step.
5. One ADC task samples through the steps into a bounded RAM buffer. CPU/network actions run separately.
6. Stop sampling and radio, then save the result in NVS. No result upload during recovery.
7. In v2.0.2, after a normally completed, saved run, attempt the entire result in the same wake:
   one Wi-Fi connection attempt, up to six 100-sample chunks, and a separate maximum 30-second window
   bounded by the next regular slot. Require at least 3.5 V before connecting and before each chunk.
   Abnormal runs, unsafe battery or insufficient time skip this immediate attempt. v2.0.0–2.0.1 always defer.
8. From the following ordinary wake, upload any remaining chunks (at most two per wake), after normal
   observation upload. Retry identity is `(device, experiment id, offset)`. A matching acknowledgement advances the cursor.
   The server can rewind to a missing chunk after restore; the device releases the trace only after an
   explicit whole-result acknowledgement. These recovery requests still count against the 18-attempt budget.

An experiment wake intentionally skips the normal weather observation and nightly closing calculation.
It never inserts a perturbed experiment reading into weather graphs, SoC history or `station_night_closings`.
For example a 5-minute normal cadence may have a 10-minute weather gap around a run. Avoid the expected
night-closing slot when planning an experiment; astronomy and regular observations resume next wake.

### BME280-only voltage comparison (v2.0.4)

The [fourth recipe](examples/night-load-04-bme280.json) samples voltage every 20ms:
2 seconds idle, 7 seconds of forced BME280 measurements, and 2 seconds of recovery.
The one permitted `bme_measure` step must last at least one second and run with the radio off.
Only the existing warm sensor command and I²C read/compensation are called, roughly every 130ms;
BME initialization happens before sampling and is not measured. No ordinary readings are queued.
The optional fifth value in a BME step sample is its phase: 0 between measurements,
1 during the forced command/conversion wait, 2 during the I²C data read/compensation.
Other samples retain their four-element format. Phase is recorded at the ADC sample instant; a
very short I²C phase may be missed. A failed sensor command/read terminates the test as `sensor_failed`.

On reset during a run, the start marker becomes `interrupted`, with zero recovered RAM samples.
The same sequence is never re-executed automatically. An interrupted experiment is **not** a completed trace.
The device remembers its highest consumed sequence even after result acknowledgement/discard.
Do not reuse old database sequence numbers after restoring D1: restore the sequence high-water mark too.

## Limits (not overridable by recipe)

| Item | Limit |
|---|---|
| Recipe | schema 1, maximum 8 steps, no loops/URLs/code/GPIO writes |
| Step | 100–15,000 ms; network steps at least 1,000 ms |
| Planned total | at most 60 seconds |
| Hard deadline | planned duration rounded up + 10 seconds for bounded teardown/save; at most 70 seconds |
| ADC interval | 20–1,000 ms in 10 ms increments; actual timestamps are recorded |
| Samples | at most 600; recipe must reserve boundary margin within this cap |
| Wi-Fi | one connect step, **one** connect attempt; one HTTPS probe, no immediate retry |
| Starting battery | valid 16-conversion average, at least 3.5 V and not emergency |
| Runtime protection | independent rolling mean of 8 valid samples below 3.4 V aborts; 8 consecutive invalid samples abort |
| Abort deadline | shorten remaining budget to 3 seconds; if save cannot finish, next wake reports interrupted |
| Emergency | existing <=3.3 V / unavailable rule remains; OTA and maintenance cannot execute inside a run |
| Delivery | 100 samples per chunk; v2.0.2 up to 6 just after a normal run, otherwise 2 per ordinary wake; at most 18 HTTP attempts total per run |
| Failed delivery | wait at least 1 hour before another wake attempts delivery; attempt persisted **before** HTTP |
| Exhausted delivery | retain result, no more uploads; administrator must explicitly discard to unblock experiments |
| Storage | existing records partition, separate `experiment_v2` namespace; no partition change or queue erasure |

Small intervals require shorter runs. For example 60 seconds at 20 ms is rejected rather than silently downsampled.
No samples are fabricated to make up for scheduler delays. Eight samples at 1,000 ms have a much slower
protection response than at 20 ms: use the 50 ms template for initial voltage/load tests.
The firmware needs at least 800 free NVS entries before accepting a recipe and refuses if ordinary backlog exceeds 8.
Results occupy about 8 KB of local storage; the exact struct layout is checked at build time. NVS writes are outside
the valid sampling window. This refers to application writes; SDK radio initialization/PHY calibration may
perform its own work, and is part of the measured connection load. Loss of power before the final save loses
the RAM trace, not the normal queue.
`storage_error` disables experiments rather than erasing data or blocking ordinary observations.

These thresholds are conservative software choices, **not validation of cell/board safety at that voltage**.
The existing current-firmware OTA voltage gate still controls the first installation of 2.0.0.
After installation, automatic OTA uses 3.6 V and an explicit manual OTA request uses 3.5 V, as in local 1.1.

## Measurement meaning

The normal battery value remains the original 16-conversion calibrated mean.
Experiment samples bypass that software averaging, not the hardware divider/filter or ADC calibration.
Each row is `[elapsed_microseconds, step_index, raw_adc_code_or_null, calibrated_battery_millivolts_or_null]`.
The timestamp is taken immediately before the individual ADC conversion; it is **not** guaranteed uniform sampling.
The ADC estimate retains the existing board-divider factor of 2 and curve-fitting calibration.
It does not measure battery current, solar-panel power, the 3.3 V rail, true open-circuit voltage or instantaneous cell SoC.
Previously discussed V1.0/V1.1 schematic/filter hypotheses are not proof of the actual V1.2 board transfer function.

`cpu_load` is synthetic integer work with RTOS yields, not calibrated load power or a guaranteed utilization percentage.
`wifi_connect` includes connection work followed by waiting until that step's budget ends.
`network_probe` is one small authenticated JSON request to this same Worker, including TLS overhead.
`step_results` contains actual start/end microseconds and success flags. Unexecuted steps stay `[0,0,false]`.
Wi-Fi-off recovery is an `idle` step after `wifi_stop`.
The 16-sample precheck and durable marker precede the trace; the baseline is **awake idle**, not deep-sleep current.

## Server interface (admin Access authentication required)

Before activation apply additive migrations through `0016_station_experiments.sql` and deploy the Worker.
Existing observations and their schema do not change. New records are in `station_experiments`,
`station_experiment_chunks`, and `station_experiment_events`; SQL backup/count verification includes them.
No new scheduled polling job is introduced. At most 6 data chunks are stored per manual run.

- `POST /admin/api/stations/{device_id}` with `{ "action":"experiment", "recipe": ... }`
  queues a recipe for six hours. The server assigns UUID and monotonically increasing sequence.
- Requires a recent (within 2 hours) 2.x+ status with available, idle experiment state. Pause approved OTA
  and stop/wait out maintenance first. Only one queued experiment; incomplete results must be handled first.
- `GET /admin/api/stations/{device_id}/experiments` lists latest 20 runs.
- `GET /admin/api/stations/{device_id}/experiments/{id}` returns metadata and up to 6 chunks, ordered by offset.
  `status=completed` means delivery finished; read `result_meta.outcome` to know whether the experiment succeeded.
- `POST /admin/api/stations/{device_id}` with `{ "action":"experiment_cancel", "sequence":123 }`
  cancels/discards that exact run. Partial server results and audit records are retained.
- The device's own credential protects `/v1/station/experiment/probe` and `/v1/station/experiment/results`.
  Results are not publicly exposed. Conflicting retransmissions are rejected, not overwritten.

Cancellation is **not an emergency stop**. A sleeping/offline device may already have queued a recipe and run it
before its next contact. Cancellation takes effect when the device receives it. Local limits remain authoritative.
There is no general script editor or experiment graph UI in this firmware change; the API and example below are ready
for that later interface. The existing administrator status JSON already displays experiment state.

Example recipe: [examples/voltage-load-v1.json](examples/voltage-load-v1.json), 23.1 seconds at 50 ms.
From the authenticated station administrator page's console, after server activation, an operator can submit:

```js
const recipe = /* paste the example JSON here */;
await fetch('/admin/api/stations/balcony-weather-01', {
  method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({action:'experiment',recipe})
}).then(async r=>({status:r.status,body:await r.json()}));
```

This documentation does not submit a run. Repeating tests requires explicitly requesting a new recipe/sequence.

## Local verification and remaining commissioning

- Cross-build for ESP32-C6 with static compile-time policy assertions.
- Real local SQLite migrations/API tests: validation, expiry, authorization, duplicate/conflicting/concurrent chunks,
  cancellation, zero-sample interruption and separation from weather/night-closing tables.
- Worker regression suite: **127 passed**, including the five experiment test groups; dry-run bundle passed.
- Both `firebeetle_c6_compilecheck` and real-config `firebeetle_c6` builds passed. Real-config image descriptor:
  `balcony-weather`, version `2.0.0`. Binary 1,095,296 bytes; linked flash 1,094,765 / 1,769,472 bytes (61.9%).
  Static RAM 45,228 bytes (13.8%); this is not peak runtime heap/stack under TLS.
  Binary is local under `.pio/artifacts/firebeetle_c6/firmware.bin` and excluded from Git because it embeds credentials.
  No signing manifest was generated, no key was rotated, and no migration/server/device was activated.
- Hardware verification remains necessary: actual interval jitter under TLS, peak heap/stack, NVS headroom,
  power-loss interruption, maximum-run deadline, voltage abort and first actual trace. A successful build is not proof.

Installation order: back up D1 → apply pending migrations → deploy Worker → build/sign the real firmware with existing
station credentials → register/approve 2.0.0 → verify device reports 2.0.0 → pause OTA assignment → request one short run.
Never upload `firebeetle_c6_compilecheck`: it uses dummy credentials.
