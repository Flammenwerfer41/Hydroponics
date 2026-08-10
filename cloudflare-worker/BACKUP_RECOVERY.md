# D1 backup, R2 retention and restore drill

The backup job keeps the production database recoverable without exposing the private
R2 bucket or device credentials. It runs at 02:30 JST and fails before upload if the
D1 export, local import validation, sensor export, compression or checksums fail.

## Artifacts

- `d1/daily/`: full D1 SQL exports, gzip-compressed, retained for 10 days.
- `d1/weekly/`: a Sunday copy of the full export, retained for 90 days.
- `sensor/daily/`: portable JSON for the previous JST calendar day, retained for two years.
- `manifests/`: SHA-256 hashes, byte sizes and table row counts.
- `manifests/latest.json`: pointer metadata for the latest successful daily backup.

R2 remains private. The manifest deliberately contains no bearer token, credential digest,
raw client address or database row contents. The SQL archive is sensitive because it contains
credential digests and future private journal data.
Compressed objects use `application/gzip` without HTTP `Content-Encoding`, so CLI downloads
retain the exact bytes covered by the compressed SHA-256 value.

## One-time activation

1. Create the private bucket:

   ```powershell
   npx wrangler r2 bucket create hydroponics-backups
   ```

2. Apply retention rules:

   ```powershell
   npx wrangler r2 bucket lifecycle set hydroponics-backups --file r2-lifecycle.json --force
   ```

3. Create a narrowly scoped Cloudflare API token for GitHub Actions with D1 read/export
   and R2 object write permissions for this account. Store it as the GitHub Actions secret
   `CLOUDFLARE_BACKUP_API_TOKEN`. Store the account ID as `CLOUDFLARE_ACCOUNT_ID`.
4. Store the Cloudflare Access service-token credentials used by the protected admin export
   as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` GitHub Actions secrets.
5. Set the GitHub Actions repository variable `CLOUDFLARE_BACKUP_ENABLED=true`.
6. Run **Backup Cloudflare data** manually once and inspect the R2 objects before relying
   on the schedule.

The scheduled job is intentionally skipped until the enable variable exists, so merging the
workflow cannot create repeated failed runs before the bucket and credentials are ready.

## Manual backup

From `cloudflare-worker`, an authenticated Wrangler session can run:

```powershell
npm run backup:run
```

The process also requires `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in its
environment so the portable sensor export can pass Cloudflare Access.

`--dry-run` performs the D1 export, clean local import and checksum generation without R2 writes:

```powershell
node scripts/backup-d1-to-r2.mjs --dry-run
```

For integration tests against a disposable local Wrangler database, add
`--local --source-dir <disposable-wrangler-project-directory>`. The directory must contain
its own `wrangler.jsonc` and `.wrangler` state; it must never point at production data.
Add `--output-dir <new-directory>` to retain the generated manifest and compressed artifacts
for a subsequent restore drill.

## Restore drill

Never restore into the production D1 database. Download one manifest and its referenced SQL
archive, then choose a directory that does not yet exist:

```powershell
npx wrangler r2 object get hydroponics-backups/manifests/latest.json --file .backup-work/manifest.json --remote
npx wrangler r2 object get hydroponics-backups/<manifest-artifact-key> --file .backup-work/database.sql.gz --remote
node scripts/restore-d1-backup.mjs `
  --manifest .backup-work/manifest.json `
  --archive .backup-work/database.sql.gz `
  --persist-to .backup-work/restored-d1
```

The restore command verifies compressed and uncompressed SHA-256 hashes, imports the SQL into
a new local Wrangler D1 directory, and compares every application table count with the snapshot.
It refuses an existing target directory and deletes a failed restore target.

Only after a local drill succeeds should a replacement remote D1 database be created, imported,
verified, and swapped into the Worker binding. Production rollback is a binding change, not an
in-place destructive import.
