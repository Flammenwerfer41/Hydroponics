import test from "node:test";
import assert from "node:assert/strict";
import { cleanupRetryDelaySeconds, removeJournalObjects } from "../src/journal/cleanup.js";

test("R2 cleanup retries back off and cap at one day", () => {
  assert.equal(cleanupRetryDelaySeconds(1), 300);
  assert.equal(cleanupRetryDelaySeconds(2), 600);
  assert.equal(cleanupRetryDelaySeconds(3), 1200);
  assert.equal(cleanupRetryDelaySeconds(30), 86400);
});

test("failed R2 deletions are persisted for a later retry", async () => {
  const queued = [];
  const database = {
    prepare() {
      return {
        bind(...values) {
          return { async run() { queued.push(values); } };
        }
      };
    }
  };
  const bucket = { async delete() { throw new Error("temporary outage"); } };
  await removeJournalObjects(database, bucket, {
    full_object_key: "journal/day/photo.webp",
    thumbnail_object_key: "journal/day/thumb.webp"
  }, "journal_deleted");

  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map((values) => values[2]).sort(), [
    "journal/day/photo.webp",
    "journal/day/thumb.webp"
  ]);
  assert.equal(queued[0][3], "journal_deleted");
});
