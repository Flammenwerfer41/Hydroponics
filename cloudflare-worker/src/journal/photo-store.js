import { JournalRequestError } from "./contract.js";
import { journalDay } from "./query-store.js";

const SITE_ID = "home-lab";

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

export async function journalPhotoObject(database, id) {
  return database.prepare(`
    SELECT jp.full_object_key, jp.thumbnail_object_key, jp.mime_type, jp.byte_size,
      jp.thumbnail_byte_size, jp.width, jp.height, jp.created_at, jp.updated_at
    FROM journal_photos jp
    JOIN journal_days jd ON jd.id = jp.journal_day_id
    WHERE jp.journal_day_id = ?1 AND jd.site_id = ?2 AND jd.deleted_at IS NULL
  `).bind(id, SITE_ID).first();
}

export async function journalCropPhotoObject(database, journalId, cropId, photoId) {
  return database.prepare(`
    SELECT jcp.id, jcp.crop_id, jcp.full_object_key, jcp.thumbnail_object_key,
      jcp.mime_type, jcp.byte_size, jcp.thumbnail_byte_size, jcp.width, jcp.height,
      jcp.sort_order, jcp.created_at, jcp.updated_at
    FROM journal_crop_photos jcp
    JOIN journal_days jd ON jd.id = jcp.journal_day_id
    WHERE jcp.id = ?1 AND jcp.journal_day_id = ?2 AND jcp.crop_id = ?3
      AND jd.site_id = ?4 AND jd.deleted_at IS NULL
  `).bind(photoId, journalId, cropId, SITE_ID).first();
}

export async function journalAllPhotoObjects(database, id) {
  const [cover, cropResult] = await Promise.all([
    journalPhotoObject(database, id),
    database.prepare(`
      SELECT full_object_key, thumbnail_object_key
      FROM journal_crop_photos WHERE journal_day_id = ?1
    `).bind(id).all()
  ]);
  return [cover, ...rows(cropResult)].filter(Boolean);
}

export async function attachJournalPhoto(database, id, photo, actor, revision, now = new Date()) {
  const timestamp = now.toISOString();
  const results = await database.batch([
    database.prepare(`
      UPDATE journal_days SET revision = revision + 1, updated_at = ?1
      WHERE id = ?2 AND site_id = ?3 AND revision = ?4 AND deleted_at IS NULL
    `).bind(timestamp, id, SITE_ID, revision),
    database.prepare(`
      INSERT INTO journal_photos
        (journal_day_id, full_object_key, thumbnail_object_key, mime_type, byte_size,
          thumbnail_byte_size, width, height, uploaded_by, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
      WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND updated_at = ?10)
      ON CONFLICT(journal_day_id) DO UPDATE SET
        full_object_key = excluded.full_object_key,
        thumbnail_object_key = excluded.thumbnail_object_key,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        thumbnail_byte_size = excluded.thumbnail_byte_size,
        width = excluded.width,
        height = excluded.height,
        uploaded_by = excluded.uploaded_by,
        updated_at = excluded.updated_at
    `).bind(
      id,
      photo.fullObjectKey,
      photo.thumbnailObjectKey,
      photo.mimeType,
      photo.byteSize,
      photo.thumbnailByteSize,
      photo.width,
      photo.height,
      actor,
      timestamp
    ),
    database.prepare(`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
      SELECT 'admin', ?1, 'journal.photo.put', 'journal_day', ?2, ?3
      WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?2 AND updated_at = ?3)
    `).bind(actor, id, timestamp)
  ]);
  if (Number(results?.[0]?.meta?.changes ?? 0) === 0) {
    throw new JournalRequestError("revision_conflict", "The journal was updated elsewhere", 409);
  }
  return journalDay(database, id);
}

export async function removeJournalPhoto(database, id, actor, revision, now = new Date()) {
  const timestamp = now.toISOString();
  const results = await database.batch([
    database.prepare(`
      UPDATE journal_days SET revision = revision + 1, updated_at = ?1
      WHERE id = ?2 AND site_id = ?3 AND revision = ?4 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM journal_photos WHERE journal_day_id = ?2)
    `).bind(timestamp, id, SITE_ID, revision),
    database.prepare(`
      DELETE FROM journal_photos WHERE journal_day_id = ?1
        AND EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND updated_at = ?2)
    `).bind(id, timestamp),
    database.prepare(`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
      SELECT 'admin', ?1, 'journal.photo.delete', 'journal_day', ?2, ?3
      WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?2 AND updated_at = ?3)
    `).bind(actor, id, timestamp)
  ]);
  if (Number(results?.[0]?.meta?.changes ?? 0) === 0) {
    throw new JournalRequestError("revision_conflict", "Photo is missing or the journal changed", 409);
  }
  return journalDay(database, id);
}

export async function attachJournalCropPhoto(
  database,
  journalId,
  cropId,
  photo,
  actor,
  revision,
  now = new Date()
) {
  const entry = await journalDay(database, journalId);
  if (!entry) return null;
  if (!entry.sections.some((section) => section.crop_id === cropId)) {
    throw new JournalRequestError("unknown_crop_section", "해당 작물 기록이 없습니다", 404);
  }
  const occupied = new Set(
    (entry.sections.find((section) => section.crop_id === cropId)?.photos ?? [])
      .map((item) => item.sort_order)
  );
  const sortOrder = [0, 1, 2, 3, 4, 5].find((value) => !occupied.has(value));
  if (sortOrder === undefined) {
    throw new JournalRequestError("crop_photo_limit", "작물별 사진은 최대 6장입니다", 409);
  }
  const photoId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const nextRevision = revision + 1;
  const results = await database.batch([
    database.prepare(`
      UPDATE journal_days SET revision = revision + 1, updated_at = ?1
      WHERE id = ?2 AND site_id = ?3 AND revision = ?4 AND deleted_at IS NULL
    `).bind(timestamp, journalId, SITE_ID, revision),
    database.prepare(`
      INSERT INTO journal_crop_photos
        (id, journal_day_id, crop_id, full_object_key, thumbnail_object_key,
          mime_type, byte_size, thumbnail_byte_size, width, height, sort_order,
          uploaded_by, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
      WHERE EXISTS (
        SELECT 1 FROM journal_days WHERE id = ?2 AND revision = ?14 AND updated_at = ?13
      )
    `).bind(
      photoId,
      journalId,
      cropId,
      photo.fullObjectKey,
      photo.thumbnailObjectKey,
      photo.mimeType,
      photo.byteSize,
      photo.thumbnailByteSize,
      photo.width,
      photo.height,
      sortOrder,
      actor,
      timestamp,
      nextRevision
    ),
    database.prepare(`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
      SELECT 'admin', ?1, 'journal.crop_photo.put', 'journal_crop_photo', ?2, ?3
      WHERE EXISTS (SELECT 1 FROM journal_crop_photos WHERE id = ?2)
    `).bind(actor, photoId, timestamp)
  ]);
  if (Number(results?.[0]?.meta?.changes ?? 0) === 0) {
    throw new JournalRequestError("revision_conflict", "The journal was updated elsewhere", 409);
  }
  return journalDay(database, journalId);
}

export async function removeJournalCropPhoto(
  database,
  journalId,
  cropId,
  photoId,
  actor,
  revision,
  now = new Date()
) {
  const timestamp = now.toISOString();
  const nextRevision = revision + 1;
  const results = await database.batch([
    database.prepare(`
      UPDATE journal_days SET revision = revision + 1, updated_at = ?1
      WHERE id = ?2 AND site_id = ?3 AND revision = ?4 AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM journal_crop_photos
          WHERE id = ?5 AND journal_day_id = ?2 AND crop_id = ?6
        )
    `).bind(timestamp, journalId, SITE_ID, revision, photoId, cropId),
    database.prepare(`
      DELETE FROM journal_crop_photos
      WHERE id = ?1 AND journal_day_id = ?2 AND crop_id = ?3
        AND EXISTS (
          SELECT 1 FROM journal_days WHERE id = ?2 AND revision = ?5 AND updated_at = ?4
        )
    `).bind(photoId, journalId, cropId, timestamp, nextRevision),
    database.prepare(`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
      SELECT 'admin', ?1, 'journal.crop_photo.delete', 'journal_crop_photo', ?2, ?3
      WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?4 AND updated_at = ?3)
    `).bind(actor, photoId, timestamp, journalId)
  ]);
  if (Number(results?.[0]?.meta?.changes ?? 0) === 0) {
    throw new JournalRequestError("revision_conflict", "Photo is missing or the journal changed", 409);
  }
  return journalDay(database, journalId);
}
