import test from "node:test";
import assert from "node:assert/strict";

import {
  JournalRequestError,
  parseJournalInput,
  parseJournalListQuery
} from "../src/journal/contract.js";
import { parsePhotoUpload } from "../src/journal/photo.js";
import { publicJournalDay } from "../src/journal/store.js";

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

test("accepts one compressed photo and thumbnail with a journal revision", () => {
  const form = new FormData();
  form.set("photo", new Blob([new Uint8Array(1200)], { type: "image/webp" }), "photo.webp");
  form.set("thumbnail", new Blob([new Uint8Array(300)], { type: "image/webp" }), "thumb.webp");
  form.set("revision", "3");
  form.set("width", "1600");
  form.set("height", "900");

  const result = parsePhotoUpload(form);
  assert.equal(result.revision, 3);
  assert.equal(result.width, 1600);
  assert.equal(result.photo.size, 1200);
  assert.equal(result.thumbnail.size, 300);
});

test("rejects unsupported and oversized journal photos", () => {
  const unsupported = new FormData();
  unsupported.set("photo", new Blob(["x"], { type: "image/png" }), "photo.png");
  unsupported.set("thumbnail", new Blob(["x"], { type: "image/png" }), "thumb.png");
  unsupported.set("revision", "1");
  unsupported.set("width", "100");
  unsupported.set("height", "100");
  assert.throws(() => parsePhotoUpload(unsupported), /must be WebP/);

  const oversized = new FormData();
  oversized.set("photo", new Blob([new Uint8Array(1_000_001)], { type: "image/webp" }), "photo.webp");
  oversized.set("thumbnail", new Blob(["x"], { type: "image/webp" }), "thumb.webp");
  oversized.set("revision", "1");
  oversized.set("width", "1600");
  oversized.set("height", "900");
  assert.throws(
    () => parsePhotoUpload(oversized),
    (error) => error instanceof JournalRequestError && error.status === 413
  );
});

function publicJournalDatabase(visibility = "public") {
  return {
    prepare(sql) {
      return {
        bind() {
          if (sql.includes("SELECT visibility FROM journal_days")) {
            return { async first() { return { visibility }; } };
          }
          if (sql.includes("SELECT id, site_id, zone_id")) {
            return { async first() { return {
              id: "11111111-1111-4111-8111-111111111111",
              site_id: "home-lab",
              zone_id: "tower-01",
              journal_date: "2026-08-10",
              common_note: "양액 확인",
              visibility: "public",
              revision: 3,
              created_by: "owner@example.com",
              created_at: "2026-08-10T01:00:00Z",
              updated_at: "2026-08-10T02:00:00Z"
            }; } };
          }
          if (sql.includes("FROM journal_day_values")) {
            return { async all() { return { results: [{
              metric: "solution_ph", value: 6.2, unit: "pH", source: "manual",
              qualifier: null, measured_at: "2026-08-10T12:00:00+09:00"
            }] }; } };
          }
          if (sql.includes("FROM journal_sections js JOIN crops")) {
            return { async all() { return { results: [{
              id: "section-secret", crop_id: "crop-basil", crop_name: "바질",
              title: "관찰", body: "새잎", sort_order: 0,
              created_at: "private", updated_at: "private"
            }] }; } };
          }
          if (sql.includes("FROM journal_section_tags")) {
            return { async all() { return { results: [] }; } };
          }
          if (sql.includes("FROM journal_photos")) {
            return { async first() { return null; } };
          }
          if (sql.includes("FROM journal_crop_photos")) {
            return { async all() { return { results: [] }; } };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }
      };
    }
  };
}

test("public journal strips administrative identity and hides private days", async () => {
  assert.equal(await publicJournalDay(publicJournalDatabase("private"), "id"), null);
  const entry = await publicJournalDay(publicJournalDatabase(), "id");
  assert.equal(entry.common_note, "양액 확인");
  assert.equal(entry.sections[0].crop_name, "바질");
  assert.equal(entry.measurements.solution_ph.source, undefined);
  assert.equal(entry.created_by, undefined);
  assert.equal(entry.revision, undefined);
  assert.equal(entry.site_id, undefined);
  assert.equal(entry.sections[0].id, undefined);
});
