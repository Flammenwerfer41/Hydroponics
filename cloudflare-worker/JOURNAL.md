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
- `journal_photos`: one R2-backed photo reference and thumbnail per journal day
- `journal_crop_photos`: up to six R2-backed photos per crop and journal day

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
GET    /admin/api/journal/:id/photo[?variant=thumbnail]
PUT    /admin/api/journal/:id/photo
DELETE /admin/api/journal/:id/photo
GET    /admin/api/journal/:id/crops/:cropId/photos/:photoId[?variant=thumbnail]
POST   /admin/api/journal/:id/crops/:cropId/photos
DELETE /admin/api/journal/:id/crops/:cropId/photos/:photoId
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
- one representative photo for the day and up to six photos for each crop section.

The administrator interface accepts either a mobile camera capture or an existing image.
It converts each selected image to WebP in a browser-side WASM worker, limits the long edge
to 1920 pixels, and creates a 420-pixel thumbnail. A full image is capped at 1 MB and a
thumbnail at 100 KB before transmission. R2 stores the image objects in the private
`hydroponics-journal-photos` bucket while D1 stores only metadata and object keys. Both
photo reads and writes remain behind Cloudflare Access. Public journal display and firmware
changes remain outside this release.
