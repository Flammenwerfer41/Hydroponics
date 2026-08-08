# D1 migrations

`0001_initial.sql` is the first versioned schema for sensor ingestion and future
cloud features. IDs are stable machine identifiers; display names remain editable.

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

## Rollback

Cloudflare D1 migrations are forward-only. Before a production migration, export
the database and test the migration locally. If `0001_initial.sql` must be undone
before production data exists, delete and recreate the D1 database. Once production
data exists, restore the export into a new database and switch the binding instead
of dropping tables in place.

No migration or deployment is performed merely by committing these files.

