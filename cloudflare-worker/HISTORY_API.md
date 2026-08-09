# Measurement history API

The public, read-only history API exposes D1 sensor data without device credentials,
audit hashes, or internal database row IDs. All calendar dates and aggregation buckets
use `Asia/Tokyo`; stored timestamps remain ISO 8601 UTC values.

## Endpoints

| Endpoint | Purpose | Default range | Maximum range | Cache |
| --- | --- | ---: | ---: | ---: |
| `GET /v1/readings/latest` | Latest matching reading | 1 day | 7 days | 30 seconds |
| `GET /v1/readings` | Raw readings with cursor pagination | 1 day | 7 days | 30 seconds |
| `GET /v1/history/hourly` | Hourly metric summaries | 7 days | 31 days | 5 minutes |
| `GET /v1/history/daily` | Daily metric summaries | 30 days | 366 days | 15 minutes |
| `GET /v1/export.json` | Wide JSON download | 1 day | 31 days | no-store |
| `GET /v1/export.csv` | UTF-8 CSV download | 1 day | 31 days | no-store |

All routes support `site_id`, `zone_id`, `device_id`, and a comma-separated `metrics`
filter. A range can be selected with either:

- `date=2026-08-09` for one exact JST calendar day;
- `from=<ISO timestamp>&to=<ISO timestamp>` with explicit offsets; or
- `days=<integer>` ending at `to` or the current time.

Raw history additionally accepts `limit` from 1 to 1000 and a `cursor` parameter
using the opaque `next_cursor` returned by the previous response. A cursor preserves descending
`measured_at` order even when delayed LittleFS recovery inserts older measurements.

## Examples

```text
/v1/readings/latest?device_id=esp32-01
/v1/readings?date=2026-08-09&device_id=esp32-01&limit=720
/v1/history/hourly?days=7&device_id=esp32-01
/v1/history/daily?days=30&device_id=esp32-01
/v1/export.csv?date=2026-08-09&device_id=esp32-01
```

## Response rules

- `schema_version` is currently `1`.
- Raw readings retain each field's `value`, `quality`, and optional diagnostic.
- Missing or invalid fields never discard an otherwise valid reading.
- Hourly and daily minimum, maximum, and mean use only `quality=valid` values.
- Aggregates also return total, valid, and missing sample counts.
- Units are declared once in the response and in each aggregate metric.
- JSON is standard UTF-8 with `null`; CSV includes a UTF-8 BOM for spreadsheet tools.
- Export is limited to 25,000 readings. Narrower ranges are requested instead of
  silently truncating a larger result.

Public responses include CORS headers. Successful cached responses expose
`X-Data-Cache: HIT`, `MISS`, or `BYPASS`; exports are intentionally not cached.

## Error behavior

Invalid identifiers, timestamps, metrics, cursors, unknown parameters, and oversized
ranges return a stable JSON `error.code`. D1 failures return HTTP 500 without exposing
SQL text. A missing D1 binding returns HTTP 503. No history route accepts mutations.
