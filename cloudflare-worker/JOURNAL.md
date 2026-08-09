# Cultivation journal

The cultivation journal is an Access-protected administrator feature. It keeps one
record per JST calendar date for `home-lab` / `tower-01` and separates shared tower
management notes from crop-specific observations.

## Data model

- `journal_days`: date, shared note, whole-record visibility and optimistic revision
- `journal_sections`: one optional free-text section per crop and day
- `journal_tags`: reusable activity labels such as observation, nutrient work and harvest
- `journal_section_tags`: activity labels attached to crop sections
- `journal_day_values`: named manual measurements, currently pH, EC and solution top-up

Manual values use canonical metric names and a `source` column instead of dedicated
columns on `journal_days`. A future pH or EC sensor can therefore write the same metric
with `source = 'sensor'` without changing the journal-day schema. Top-up liquid type is
stored as a qualifier and volume is stored in litres.

Visibility applies to the complete daily record. Crop sections do not have independent
visibility. The public dashboard does not expose journal records yet; `public` records
are ready for that later read-only API.

The original `journal_entries` table from migration 0001 is retained for migration
compatibility but is not used by this feature.

## Administrator API

All routes require a valid Cloudflare Access JWT and return `Cache-Control: no-store`.

```text
GET    /admin/api/journal/meta
GET    /admin/api/journal?year=2026&month=8&day=9&crop_id=...&tag_id=...
GET    /admin/api/journal/:id
POST   /admin/api/journal
PUT    /admin/api/journal/:id
DELETE /admin/api/journal/:id
```

`PUT` requires the latest positive integer `revision`. Conflicting edits return HTTP
409 instead of silently overwriting a newer version. Deletes are soft deletes, and
create, update and delete operations append an administrator audit record.

## Administrator interface

Open `/admin/journal/` after Access login. The list supports year, month, day, crop and
activity filters. A daily record may contain:

- one shared management note;
- optional pH and EC values;
- optional solution top-up volume and liquid type;
- optional crop sections for basil and perilla, each with free text and activity tags.

Photo upload, R2 objects, public journal display and firmware changes are deliberately
outside this first journal release.
