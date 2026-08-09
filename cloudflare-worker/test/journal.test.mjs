import test from "node:test";
import assert from "node:assert/strict";

import {
  JournalRequestError,
  parseJournalInput,
  parseJournalListQuery
} from "../src/journal/contract.js";

test("normalizes a daily journal with crop sections and manual values", () => {
  const result = parseJournalInput({
    journal_date: "2026-08-10",
    common_note: "  양액을 보충함  ",
    visibility: "private",
    measurements: {
      solution_ph: "6.1",
      electrical_conductivity: 1.4,
      solution_added_volume: "2.5",
      solution_added_liquid_type: "prepared_solution"
    },
    sections: [{
      crop_id: "crop-basil",
      title: " 새잎 ",
      body: " 성장 상태 양호 ",
      tag_ids: ["tag-observation", "tag-observation"]
    }]
  });

  assert.equal(result.common_note, "양액을 보충함");
  assert.equal(result.measurements.solution_ph, 6.1);
  assert.equal(result.measurements.solution_added_volume, 2.5);
  assert.deepEqual(result.sections[0], {
    crop_id: "crop-basil",
    title: "새잎",
    body: "성장 상태 양호",
    tag_ids: ["tag-observation"],
    sort_order: 0
  });
});

test("allows partial journals while rejecting a completely empty day", () => {
  assert.equal(parseJournalInput({
    journal_date: "2026-08-10",
    measurements: { solution_ph: 6.2 }
  }).measurements.solution_ph, 6.2);

  assert.throws(
    () => parseJournalInput({ journal_date: "2026-08-10" }),
    (error) => error instanceof JournalRequestError && error.code === "empty_journal"
  );
});

test("rejects duplicate crops, impossible dates and unsafe measurement ranges", () => {
  assert.throws(() => parseJournalInput({
    journal_date: "2026-02-30",
    common_note: "invalid"
  }), /journal_date/);
  assert.throws(() => parseJournalInput({
    journal_date: "2026-08-10",
    measurements: { solution_ph: 15 }
  }), /pH/);
  assert.throws(() => parseJournalInput({
    journal_date: "2026-08-10",
    sections: [
      { crop_id: "crop-basil", body: "one" },
      { crop_id: "crop-basil", body: "two" }
    ]
  }), /only once/);
});

test("requires the top-up liquid type only when volume is recorded", () => {
  assert.throws(() => parseJournalInput({
    journal_date: "2026-08-10",
    measurements: { solution_added_volume: 2 }
  }), /liquid type/);
  assert.equal(parseJournalInput({
    journal_date: "2026-08-10",
    common_note: "no top-up"
  }).measurements.solution_added_liquid_type, null);
});

test("accepts only positive integer revisions", () => {
  const base = { journal_date: "2026-08-10", common_note: "양액 확인" };
  assert.equal(parseJournalInput({ ...base, revision: 3 }).revision, 3);
  assert.throws(() => parseJournalInput({ ...base, revision: 0 }), /revision/);
  assert.throws(() => parseJournalInput({ ...base, revision: 1.5 }), /revision/);
});

test("builds exact JST calendar filters and validates query parameters", () => {
  const query = parseJournalListQuery(
    new URL("https://worker.example/admin/api/journal?year=2026&month=8&day=10&crop_id=crop-basil&tag_id=tag-harvest"),
    new Date("2026-08-10T01:00:00Z")
  );
  assert.deepEqual(query, {
    year: 2026,
    month: 8,
    day: 10,
    cropId: "crop-basil",
    tagId: "tag-harvest",
    limit: 100
  });
  assert.throws(
    () => parseJournalListQuery(new URL("https://worker.example/admin/api/journal?year=2026&month=2&day=30")),
    (error) => error.code === "invalid_filter"
  );
});
