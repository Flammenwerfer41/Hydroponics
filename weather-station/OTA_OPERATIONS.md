# Weather station OTA operations

## 2026-11-14 — temporary five-minute release v1.0.2

- Only station cadence/version changed: 300-second wall-clock slots; queue capacity,
  retries, voltage gate, partitions, credentials and tower firmware unchanged.
- Production firmware built and signed successfully; Worker tests 106/106 passed.
- SHA-256: `50f0393ebc1cff13783e436b90431da90068cfebeddef6819e8575a321be89fc`.
- Private ignored artifacts: `weather-station/releases/1.0.2/{manifest.json,firmware.bin}`.
- Not registered or approved yet: browser upload requires the user to enable the
  ChatGPT Chrome extension's file URL access. No production mutation performed.
- Real v1.0.1 report verified at 2026-11-14 21:09:52 JST; observation at 21:09:49 JST
  has valid BME280 values and battery input 3.45425 V. Hardware is now connected
  per the user, superseding the old USB-only commissioning notes below.
- Existing 3.8 V OTA gate remains. Even after approval, installation will wait
  until the measured voltage qualifies. No automatic return date is configured;
  restoring the 15-minute cadence requires a higher-version signed release.

## Status — 2026-10-12 JST

- Production Worker: `hydroponics-jma-weather`.
- Admin: https://hydroponics-jma-weather.flammenwerfer41.workers.dev/admin/station/
- D1 migrations 0012/0013 applied; `balcony-weather-01` enrolled independently of the tower.
- Private R2: `hydroponics-station-firmware`, binding `STATION_FIRMWARE`.
  Public r2.dev access is disabled and no custom domain is attached.
- Worker holds `STATION_OTA_PUBLIC_KEY` only. The device credential is stored as a SHA-256 digest in D1.
- **Test release v1.0.1 registered and approved for `balcony-weather-01`; installation pending device confirmation.**
  Registration: 2026-10-12 22:26:25 JST; approval: 22:26:46 JST. No maintenance request active.
  This is a version-only test build, signed with the existing trust key. No USB flash was performed
  during this release step. The last observed device report remains v1.0.0 at approval time.
  SHA-256: `1f73d9c77ddf394404ee0a9715eef8de8443213cc8b17fb0f3b6746f965abf18`.
  Private, Git-ignored release files: `weather-station/releases/1.0.1/{manifest.json,firmware.bin}`.
- The credential/trust-key-enabled v1.0.0 was USB installed in the subsequent commissioning step.
  The device reported v1.0.0 at 2026-10-12 22:18:55 JST; its first measurement timestamp was
  22:18:52 JST and reception was 22:18:54 JST. Wi-Fi/time/authentication/ingestion succeeded.
  The board is still USB-only with no sensors/battery; actual signed OTA remains untested.

## Private material — do not commit or publish

Local directory: `%LOCALAPPDATA%/HydroponicsPrivate/weather-station`.
On this workstation it is `C:/Users/KWS/AppData/Local/HydroponicsPrivate/weather-station`.
2026-11-14 correction: the original files are actually retained under the packaged
Codex app's redirected local storage:
`C:/Users/KWS/AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/HydroponicsPrivate/weather-station`.
The signing key there was checked against `include/secrets.h` successfully without
printing secrets. If the normal LOCALAPPDATA path is absent, check this location;
do not generate a replacement key. No private material was moved or copied.
Windows permissions restrict this directory to the current user and SYSTEM; it is outside Dropbox.

| File | Purpose |
| --- | --- |
| `ota-signing.pem` | RSA-2048 private signing key; never upload to Worker, R2, Git or device |
| `ota-signing.pem.public.pem` | Device/Worker trust key |
| `device-credential.json` | Station-only Bearer token; never reuse the tower's token |
| `device-config.h` | Two definitions to merge into ignored `include/secrets.h` before USB commissioning |
| `worker-public-key.json` | Public-key-only Wrangler secret input |
| `credential.sql` | D1 provisioning SQL containing only the credential hash |

Create a separate **encrypted offline backup** of the private key and credential before sealing
the device. Such a backup has not been made by this task. Reinstalling Windows may remove this
directory; Git/Dropbox cannot restore it. Do not regenerate a key casually after losing it.

Provisioning helper (idempotent, fails rather than overwrite different material):
`node weather-station/scripts/prepare-server.mjs <private-directory>`.
It creates local files only; it does not enroll, deploy, flash, or approve anything.
Provisioning SQL deliberately does not replace an existing credential ID: verify its hash
and revocation state when reusing it. A revoked token requires explicit rotation.

## Normal release workflow

1. Change station code; increment `PROJECT_VER` in `weather-station/CMakeLists.txt`.
   Use a strictly higher `major.minor.patch`. Do not change the tower firmware.
2. Run `node --test` in `cloudflare-worker` and the full-path firmware compile check.
3. After the initial device configuration has been prepared, from the repository root run:

```powershell
.\weather-station\scripts\prepare-release.ps1 -Version 1.0.1 -PrivateKey "$env:LOCALAPPDATA\HydroponicsPrivate\weather-station\ota-signing.pem"
```

This validates local configuration, builds the normal environment, copies the exact BIN into
`weather-station/releases/1.0.1/`, and produces `manifest.json`. The example version must match
PROJECT_VER and be higher than the installed version. It never uploads to a chip or server.
The local `secrets.h` now includes the prepared token/trust key and passes preflight.
The same prepared configuration is now installed on the board via USB.
Version directories are never overwritten; failed builds/signatures must not be uploaded.

4. Open the admin page through Cloudflare Access. Select the station and both files;
   click **업로드 · 검증 · 등록**. This does not approve OTA.
5. Select the registered version and explicitly approve. At its next wake (normally up to
   ~15 minutes) the station receives a signed manifest in the measurement response.
6. Use **상태 새로고침** after the next wake. Inspect the last reported version/time,
   target hash, queue and attempts. The UI does not poll in a tight loop.

Neither HTTP success nor an approval is proof of installation. A reported matching version
is evidence that the application started, not a full sensor, power or rollback qualification.
Reports older than 30 minutes are marked stale. No synthetic device reports should be posted
to production for testing: they would look like real board confirmation.

## Server and device checks

- Access JWT verification and same-origin checks protect admin mutations. Device endpoints use
  their own Bearer credentials. Static management HTML is also protected by Access.
- Binary uploads are bounded by the signed size, max 1,769,472 bytes, and checked against RSA,
  SHA-256, ESP32-C6 header, `balcony-weather` project name and manifest version.
- Hash-addressed R2 objects are create-only. Approval rereads/verifies the stored bytes.
  D1 release registration and action history are transactional. R2 and D1 are not a single
  transaction: if registration fails, an unreferenced private object can remain. Re-submit the
  same files after fixing the failure; this does not activate a release or overwrite an object.
- Device downloads require both valid authentication and assignment of that exact image.
- Full ESP image validity, signature, version and SHA verification happen again on the device.
- Do not publish firmware BIN files: they can contain Wi-Fi credentials and device tokens.

## Bounded attempts / maintenance / pause

- OTA requires a measured battery input of at least 3.8 V. A USB-only board with no battery
  can still show a charging-circuit voltage; this is not evidence of battery capacity.
- Device limits: three attempts for the current target, counters persisted before download,
  1 hour then 6 hours backoff, max 120 seconds per attempt. Same-image reapproval does not reset it.
- Server management actions and browser uploads are not automatically retried.
- Maintenance request expires after one hour if unclaimed; a new request keeps an awake device
  in maintenance for at most 15 minutes. Polling is 30 seconds. Stop applies on next communication.
- Pause blocks future downloads; it cannot recall an already downloaded image or interrupt
  an in-progress flash immediately. Never use electrical power cuts as a remote cancel method.
- Already-installed versions are not downgraded. A deliberate recovery of old source must be
  rebuilt with a **higher version number**, tested and signed.

## Recovery and credential rotation

- Lost/leaked device token: set `revoked_at` for its exact `device_credentials.id`; issue a
  different token with a different ID. Revocation blocks uploads/control/downloads immediately.
  If rotating through OTA, install/verify the new credential while the old one still works,
  then revoke the old one. If already revoked, USB or another explicitly planned recovery is needed.
- Signing-key rotation needs a transition signed by the existing trusted key. The standard
  release helper intentionally rejects mismatched signing/device keys; plan rotation separately.
  Loss of the only trusted private key can require USB recovery.
- Built-in rollback checks local storage at first boot. Sensor or temporary network failure
  is not a rollback criterion. Actual interrupted-update/boot-failure tests are still pending.
- D1 full SQL backup includes the three station tables; restore verification recognizes them
  only when present, preserving compatibility with older backups.
- Private keys and R2 firmware objects are **not** part of D1 backups. Keep signed release
  folders and an encrypted private-material backup separately. Never delete assigned objects.

Before these additive migrations the D1 Time Travel bookmark was:
`000008ed-00000034-00005102-c7cb84f4035a6f5f1eff9edb26632710`.
This is time-limited provider recovery, not a permanent standalone backup. A full-database
restore would also rewind tower/journal data: do not use it casually to undo station settings.

## USB commissioning — installed and first server report verified

Prepared normal-environment v1.0.0 app: 1,062,848 bytes;
SHA-256 `0040e4a0c3b1267cfbe47d54e1bcee23a3cd0970f5eeffd2049c879489dd1a34`.
Build output at commissioning: `weather-station/.pio/artifacts/firebeetle_c6/firmware.bin`
(Git-ignored; subsequent builds replace this output, so it is not an immutable v1.0.0 archive).
The embedded credential/trust key match the provisioned station configuration; image and
signature checks passed. A read-only production check accepted the device token but denied
an unassigned image. No synthetic readings/status were posted.

On the next explicitly requested USB upload:

1. Hold BOOT while connecting USB; release after enumeration to remain in download mode.
   Expected USB identity: VID/PID 303A:1001, serial CC:8D:A2:F8:9B:20, ESP32-C6, 4 MB.
   Never infer identity from COM number alone.
2. Back up the current flash privately and verify the partition table before any erasure.
3. Clear only the board-only commissioning queue partition `records` (0x380000, length
   0x80000) after verifying it matches that partition table. Preserve other NVS/state.
   Do not add an automatic boot-time erase routine or erase the tower.
4. Upload the normal build, then verify actual device reports (version/time/authentication).
   No server OTA release is approved as part of this USB step.

The preparation step made no USB changes. The subsequent authorized USB installation verified
the expected C6/USB identity and exact partition table, saved a complete 4 MB backup at
`weather-station/.pio/backups/COM4-before-auth-v1-20261012-221646.bin`, cleared only the
512 KiB `records` partition, and uploaded/hash-verified the prepared image. BOOT-free RST
started the application; its real status/reading then arrived at D1. Old commissioning records
are recoverable from the private backup. No OTA release was registered/approved in the USB step;
the subsequent v1.0.1 server-only release is recorded above.
The reported `queued=1` is the status snapshot attached before acknowledgement of that first
record, not by itself evidence of a stuck queue. Sensor/battery values are not hardware-qualified.

## Remaining device commissioning (separate task)

- Prepared: token/public key merged into ignored station secrets, existing Wi-Fi preserved.
- Done: prior USB-only queue backed up and cleared; authenticated USB image and first report verified.
- New USB-only test records must still be distinguished from real battery/sensor observations.
- Test signed OTA success, signature rejection, low-voltage hold, retry budget and boot rollback.
- Connect/validate actual BME280 and battery/panel hardware before sealing the enclosure.

No additional station cron was added. Normal observation/control remains 96 wakes/day;
R2 is accessed only for release management/downloads, and history records only admin actions.
Reference: [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
