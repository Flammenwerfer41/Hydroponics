# ThingSpeak historical backfill

This one-time migration copies the public ThingSpeak channel history into D1 while
the ESP32 continues its normal dual-write operation. The live D1 boundary is never
overwritten.

## Mapping and identity

- `thingspeak:<channel_id>:<entry_id>` is the stable D1 `reading_id`.
- `created_at` becomes both `measured_at` and the historical `received_at`.
- `source` is `thingspeak_backfill`; boot ID, sequence and firmware metadata remain null.
- All eight metrics are represented. Empty fields use JSON/SQL null with `quality=missing`.
- Each measurement links to the existing production sensor catalog.
- `INSERT OR IGNORE` makes interrupted and repeated runs idempotent.

The import must stop before the earliest `source=device` reading. This prevents the
historical bridge from competing with authenticated live ingestion.

## Dry run

From `cloudflare-worker/`, supply the live boundary as an explicit ISO timestamp:

```text
pnpm backfill:thingspeak -- --before 2026-08-09T03:49:42Z
```

The dry run only downloads and validates public ThingSpeak data. It prints counts and
does not write D1.

## Apply in bounded batches

Create an R2 D1 backup first. Then run:

```text
pnpm backfill:thingspeak -- --before 2026-08-09T03:49:42Z --apply \
  --batch-size 50 --max-rows-written 60000
```

The newest historical entries are attempted first so the current dashboard becomes
continuous before older dates arrive. Wrangler's returned `rows_written` metadata is
summed after every batch. Re-running the exact command skips existing reading and metric
identities, then continues toward older entries.

Before writing, the tool reads the current contiguous backfill boundary from D1 and
normally skips completed batches entirely. If the counts indicate a gap, it safely
falls back to a full idempotent scan.

On Workers Free, leave enough of the 100,000 daily D1 row-write allowance for live
ingestion and indexes. Continue on a later UTC day if the tool reports
`write-limit-reached`. Workers Paid has a monthly included allowance, but activating that
plan is a separate billing decision.

The temporary GitHub Actions workflow `backfill-thingspeak-to-d1.yml` resumes the
migration at 00:20 UTC each day with a 60,000-row write budget. That leaves headroom for
authenticated live ingestion on Workers Free. It uses the existing backup token because
that token already has D1 write access. Once the tool reports `already-complete`, the
scheduled run performs no D1 writes and the workflow can be removed.

## Verification

After every run, compare:

```sql
SELECT source, COUNT(*) FROM readings GROUP BY source;
SELECT MIN(measured_at), MAX(measured_at) FROM readings;
SELECT COUNT(*) FROM measurement_values;
```

The final ThingSpeak backfill count must match the source feeds strictly before the live
D1 boundary. Dashboard day, week and month ranges should then render without switching
their API source.
