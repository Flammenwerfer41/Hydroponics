# D1 migrations

`0001_initial.sql` is the first versioned schema for sensor ingestion and future
cloud features. IDs are stable machine identifiers; display names remain editable.

`0002_history_indexes.sql` adds the measured-time and stable row-ID indexes used by
the public history API's cursor pagination. It does not rewrite sensor data.

`0003_actuator_control.sql` moves grow-light telemetry and control ownership to the
Worker. It adds independent actuator telemetry, command history and a JST schedule
with the initial 07:00 ON / 21:00 OFF policy, plus the room air conditioner actuator.

`0004_bridge_legacy_light_history.sql` copies the already-imported ThingSpeak
Fields 6-8 from `measurement_values` into the canonical `actuator_telemetry`
table. It is idempotent and preserves the original measured timestamps.

`0005_cultivation_journal.sql` adds date-based journals, crop-specific sections,
activity tags and extensible manual values for pH, EC and nutrient-solution top-up.
It also seeds the current basil and perilla crop catalog.

`0006_journal_photos.sql` adds the single daily representative photo metadata.
`0007_journal_crop_photos.sql` adds up to six WebP photo references per crop and
journal day. Binary image objects remain in the private R2 bucket.
`0008_r2_cleanup_queue.sql` adds an eventual-cleanup queue so temporary R2 deletion
failures are retried without leaving silent orphan objects.
`0009_jma_weather_archive.sql` adds the compound lookup index used by long-term JMA
observation storage and the single latest-forecast cache in `weather_records`.

The schema supports the current single vertical tower and additional sites, zones,
slots, devices and sensors without adding measurement-specific columns. A sensor
replacement receives a new sensor ID while historical values continue to reference
the retired sensor.

## Apply

Create the production database once, copy its ID into `wrangler.jsonc`, and apply
the committed migrations:

```text
npx wrangler d1 create hydroponics
npx wrangler d1 migrations apply hydroponics --remote
```

For local development, omit `--remote`.

Add the binding beside the existing Wrangler settings after D1 returns the database
ID:

```jsonc
"d1_databases": [
  {
    "binding": "HYDROPONICS_DB",
    "database_name": "hydroponics",
    "database_id": "<D1 database ID>",
    "migrations_dir": "migrations"
  }
]
```

## Rollback

Cloudflare D1 migrations are forward-only. Before a production migration, export
the database and test the migration locally. If `0001_initial.sql` must be undone
before production data exists, delete and recreate the D1 database. Once production
data exists, restore the export into a new database and switch the binding instead
of dropping tables in place.

No migration or deployment is performed merely by committing these files.

The history indexes can be removed with `DROP INDEX` in a later forward migration if
necessary. Do not delete an already-recorded migration entry or edit a migration after
it has reached production.
