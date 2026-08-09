import test from "node:test";
import assert from "node:assert/strict";

import {
  batchSql,
  feedToReading,
  remainingReadings,
  sqlLiteral,
  uniqueFeeds,
  utcWindows
} from "../scripts/thingspeak-backfill-support.mjs";

test("maps every ThingSpeak field and preserves missing values", () => {
  const reading = feedToReading({
    created_at: "2026-08-01T00:00:00Z",
    entry_id: 42,
    field1: "25.5",
    field2: "",
    field3: "1005.2",
    field4: "-55",
    field5: null,
    field6: "1",
    field7: "73.1",
    field8: "120"
  });

  assert.equal(reading.readingId, "thingspeak:3436358:42");
  assert.equal(reading.values[0].value, 25.5);
  assert.equal(reading.values[1].value, null);
  assert.equal(reading.values[1].quality, "missing");
  assert.equal(reading.values[5].metric, "light_status");
  assert.equal(reading.payloadSha256.length, 64);
});

test("generates idempotent reading and measurement inserts", () => {
  const reading = feedToReading({
    created_at: "2026-08-01T00:00:00Z",
    entry_id: 42,
    field1: "25.5"
  });
  const sql = batchSql([reading]);

  assert.match(sql, /INSERT OR IGNORE INTO readings/);
  assert.equal((sql.match(/INSERT OR IGNORE INTO measurement_values/g) || []).length, 8);
  assert.match(sql, /thingspeak_backfill/);
  assert.match(sql, /thingspeak_field_missing/);
});

test("escapes SQL strings and partitions partial UTC days", () => {
  assert.equal(sqlLiteral("O'Reilly"), "'O''Reilly'");
  assert.deepEqual(
    utcWindows("2026-08-01T12:00:00Z", "2026-08-03T03:00:00Z"),
    [
      { start: "2026-08-01T12:00:00.000Z", end: "2026-08-02T00:00:00.000Z" },
      { start: "2026-08-02T00:00:00.000Z", end: "2026-08-03T00:00:00.000Z" },
      { start: "2026-08-03T00:00:00.000Z", end: "2026-08-03T03:00:00.000Z" }
    ]
  );
});

test("deduplicates inclusive ThingSpeak range boundaries by entry ID", () => {
  const feeds = uniqueFeeds([
    { entry_id: 1, created_at: "2026-08-01T00:00:00Z" },
    { entry_id: 2, created_at: "2026-08-02T00:00:00Z" },
    { entry_id: 2, created_at: "2026-08-02T00:00:00Z" }
  ]);
  assert.deepEqual(feeds.map((feed) => feed.entry_id), [1, 2]);
});

test("continues below a contiguous existing backfill boundary", () => {
  const readings = [3, 2, 1].map((entryId) => feedToReading({
    entry_id: entryId,
    created_at: `2026-08-0${entryId}T00:00:00Z`
  }));

  assert.deepEqual(
    remainingReadings(readings, { count: 2, oldest: "2026-08-02T00:00:00Z" })
      .map((reading) => reading.entryId),
    [1]
  );
  assert.deepEqual(remainingReadings(readings, { count: 3, oldest: "2026-08-01T00:00:00Z" }), []);
});

test("falls back to idempotent full scan when progress is not contiguous", () => {
  const readings = [3, 2, 1].map((entryId) => feedToReading({
    entry_id: entryId,
    created_at: `2026-08-0${entryId}T00:00:00Z`
  }));
  assert.equal(
    remainingReadings(readings, { count: 1, oldest: "2026-08-02T00:00:00Z" }).length,
    3
  );
});
