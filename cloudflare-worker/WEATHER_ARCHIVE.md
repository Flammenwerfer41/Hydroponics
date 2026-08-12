# JMA weather archive

The Worker stores official JMA AMeDAS observations for indoor/outdoor comparison while
keeping only the latest Tokyo district forecast. No forecast history is retained because
forecast-based automation is not currently enabled.

## Sources and schedule

- Tokyo `44132`: temperature, humidity, pressure, wind and sunshine
- Setagaya `44126`: local precipitation, with Tokyo as the existing fallback
- Tokyo district `130010`: latest weather-distribution forecast only
- Observation check: every five minutes at UTC minute `02, 07, 12, ...`
- Forecast check: once per hour at UTC minute `07`

The observation collector first reads JMA `latest_time.txt`. It reads D1's newest stored
observation and does nothing when the JMA timestamp has not advanced. A normal cycle
therefore performs no D1 write on the intermediate five-minute check.

When recent timestamps are missing, the collector attempts up to twelve ten-minute slots
(the latest two hours) and inserts them oldest first. `INSERT OR IGNORE` and the existing
weather-record uniqueness constraint make repeated collection idempotent.

## Storage

Both datasets use the existing `weather_records` table:

- observations use station key `44132+44126` and accumulate by `observed_at`;
- forecasts use area key `130010` and replace the previous cached publication;
- the normalized dashboard payload and JMA field-quality codes are preserved as JSON;
- migration `0009_jma_weather_archive.sql` adds the source/type/time lookup index.

`GET /v1/current` reads D1 first and recalculates `age_minutes` and `stale` at request time.
If D1 has no observation yet, it falls back to a direct JMA fetch and asynchronously seeds
the archive. If JMA later becomes unavailable, the last stored observation remains readable
and is marked stale after 30 minutes.

The table is already included in the scheduled D1-to-R2 backup and restore verification.
