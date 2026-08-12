const BUCKET_NAME = "hydroponics-journal-photos";
const MAX_DELAY_SECONDS = 24 * 60 * 60;

export function cleanupRetryDelaySeconds(attempts) {
  return Math.min(MAX_DELAY_SECONDS, 5 * 60 * (2 ** Math.max(0, attempts - 1)));
}

function nextAttempt(now, attempts) {
  return new Date(now.getTime() + cleanupRetryDelaySeconds(attempts) * 1000).toISOString();
}

async function enqueue(database, objectKey, reason, caught, now = new Date()) {
  if (!database || !objectKey) return;
  const timestamp = now.toISOString();
  const message = String(caught?.message || caught || "R2 deletion failed").slice(0, 1000);
  await database.prepare(`
    INSERT INTO r2_cleanup_queue
      (id, bucket_name, object_key, reason, attempts, next_attempt_at,
       last_error, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?7)
    ON CONFLICT(bucket_name, object_key) DO UPDATE SET
      reason = excluded.reason,
      attempts = r2_cleanup_queue.attempts + 1,
      next_attempt_at = excluded.next_attempt_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(),
    BUCKET_NAME,
    objectKey,
    reason,
    nextAttempt(now, 1),
    message,
    timestamp
  ).run();
}

export async function removeJournalObjects(database, bucket, photo, reason = "journal_photo_removed") {
  if (!bucket || !photo) return;
  const keys = [...new Set([photo.full_object_key, photo.thumbnail_object_key].filter(Boolean))];
  await Promise.all(keys.map(async (key) => {
    try {
      await bucket.delete(key);
    } catch (caught) {
      console.warn("R2 photo deletion queued", { key, reason, error: caught?.message });
      try {
        await enqueue(database, key, reason, caught);
      } catch (queueError) {
        console.error("R2 photo cleanup could not be queued", {
          key,
          reason,
          error: queueError?.message
        });
      }
    }
  }));
}

export async function removeManyJournalObjects(database, bucket, photos, reason = "journal_deleted") {
  await Promise.all((photos || []).map((photo) => removeJournalObjects(database, bucket, photo, reason)));
}

export async function processJournalCleanup(database, bucket, now = new Date(), limit = 20) {
  if (!database || !bucket) return { attempted: 0, deleted: 0, failed: 0 };
  const due = await database.prepare(`
    SELECT id, object_key, attempts FROM r2_cleanup_queue
    WHERE bucket_name = ?1 AND next_attempt_at <= ?2
    ORDER BY next_attempt_at, created_at
    LIMIT ?3
  `).bind(BUCKET_NAME, now.toISOString(), limit).all();
  const rows = Array.isArray(due?.results) ? due.results : [];
  let deleted = 0;
  let failed = 0;
  for (const item of rows) {
    try {
      await bucket.delete(item.object_key);
      await database.prepare("DELETE FROM r2_cleanup_queue WHERE id = ?1").bind(item.id).run();
      deleted += 1;
    } catch (caught) {
      const attempts = Number(item.attempts) + 1;
      await database.prepare(`
        UPDATE r2_cleanup_queue
        SET attempts = ?1, next_attempt_at = ?2, last_error = ?3, updated_at = ?4
        WHERE id = ?5
      `).bind(
        attempts,
        nextAttempt(now, attempts),
        String(caught?.message || caught || "R2 deletion failed").slice(0, 1000),
        now.toISOString(),
        item.id
      ).run();
      failed += 1;
    }
  }
  return { attempted: rows.length, deleted, failed };
}
