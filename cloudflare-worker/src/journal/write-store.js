import { JOURNAL_UNITS, JournalRequestError } from "./contract.js";
import { journalDay } from "./query-store.js";

const SITE_ID = "home-lab";
const ZONE_ID = "tower-01";

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

async function validateReferences(database, input) {
  const cropIds = [...new Set(input.sections.map((section) => section.crop_id))];
  const tagIds = [...new Set(input.sections.flatMap((section) => section.tag_ids))];
  if (cropIds.length) {
    const placeholders = cropIds.map((_, index) => `?${index + 1}`).join(",");
    const result = await database.prepare(`SELECT id FROM crops WHERE id IN (${placeholders})`)
      .bind(...cropIds).all();
    if (rows(result).length !== cropIds.length) {
      throw new JournalRequestError("unknown_crop", "One or more crops do not exist");
    }
  }
  if (tagIds.length) {
    const placeholders = tagIds.map((_, index) => `?${index + 2}`).join(",");
    const result = await database.prepare(`
      SELECT id FROM journal_tags WHERE site_id = ?1 AND active = 1 AND id IN (${placeholders})
    `).bind(SITE_ID, ...tagIds).all();
    if (rows(result).length !== tagIds.length) {
      throw new JournalRequestError("unknown_tag", "One or more tags do not exist");
    }
  }
}

function replacementStatements(database, dayId, input, now, updateGuard = null) {
  const statements = [];
  if (updateGuard) {
    statements.push(database.prepare(`
      DELETE FROM journal_section_tags
      WHERE journal_section_id IN (SELECT id FROM journal_sections WHERE journal_day_id = ?1)
        AND EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND updated_at = ?2)
    `).bind(dayId, updateGuard));
    statements.push(database.prepare(`
      DELETE FROM journal_sections WHERE journal_day_id = ?1
        AND EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND updated_at = ?2)
    `).bind(dayId, updateGuard));
    statements.push(database.prepare(`
      DELETE FROM journal_day_values WHERE journal_day_id = ?1
        AND EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND updated_at = ?2)
    `).bind(dayId, updateGuard));
  }
  const measuredAt = `${input.journal_date}T12:00:00+09:00`;
  const definitions = [
    ["solution_ph", input.measurements.solution_ph, JOURNAL_UNITS.solution_ph, null],
    ["electrical_conductivity", input.measurements.electrical_conductivity, JOURNAL_UNITS.electrical_conductivity, null],
    ["solution_added_volume", input.measurements.solution_added_volume, JOURNAL_UNITS.solution_added_volume, input.measurements.solution_added_liquid_type]
  ];
  for (const [metric, value, unit, qualifier] of definitions) {
    if (value === null) continue;
    if (updateGuard) {
      statements.push(database.prepare(`
        INSERT INTO journal_day_values
          (journal_day_id, metric, value, unit, source, qualifier, measured_at)
        SELECT ?1, ?2, ?3, ?4, 'manual', ?5, ?6
        WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND updated_at = ?7)
      `).bind(dayId, metric, value, unit, qualifier, measuredAt, updateGuard));
    } else {
      statements.push(database.prepare(`
        INSERT INTO journal_day_values
          (journal_day_id, metric, value, unit, source, qualifier, measured_at)
        VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6)
      `).bind(dayId, metric, value, unit, qualifier, measuredAt));
    }
  }
  for (const section of input.sections) {
    const sectionId = crypto.randomUUID();
    if (updateGuard) {
      statements.push(database.prepare(`
        INSERT INTO journal_sections
          (id, journal_day_id, crop_id, title, body, sort_order, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
        WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?2 AND updated_at = ?8)
      `).bind(sectionId, dayId, section.crop_id, section.title || null, section.body, section.sort_order, now, updateGuard));
    } else {
      statements.push(database.prepare(`
        INSERT INTO journal_sections
          (id, journal_day_id, crop_id, title, body, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      `).bind(sectionId, dayId, section.crop_id, section.title || null, section.body, section.sort_order, now));
    }
    for (const tagId of section.tag_ids) {
      if (updateGuard) {
        statements.push(database.prepare(`
          INSERT INTO journal_section_tags (journal_section_id, tag_id)
          SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM journal_sections WHERE id = ?1)
        `).bind(sectionId, tagId));
      } else {
        statements.push(database.prepare(`
          INSERT INTO journal_section_tags (journal_section_id, tag_id) VALUES (?1, ?2)
        `).bind(sectionId, tagId));
      }
    }
  }
  return statements;
}

export async function createJournalDay(database, input, actor, now = new Date()) {
  await validateReferences(database, input);
  const id = crypto.randomUUID();
  const timestamp = now.toISOString();
  const statements = [database.prepare(`
    INSERT INTO journal_days
      (id, site_id, zone_id, journal_date, common_note, visibility, created_by, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
  `).bind(id, SITE_ID, ZONE_ID, input.journal_date, input.common_note, input.visibility, actor, timestamp)];
  statements.push(...replacementStatements(database, id, input, timestamp));
  statements.push(database.prepare(`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
    VALUES ('admin', ?1, 'journal.create', 'journal_day', ?2, ?3)
  `).bind(actor, id, timestamp));
  await database.batch(statements);
  return journalDay(database, id);
}

export async function updateJournalDay(database, id, input, actor, now = new Date()) {
  const existing = await journalDay(database, id);
  if (!existing) return null;
  if (!Number.isInteger(input.revision) || input.revision !== existing.revision) {
    throw new JournalRequestError("revision_conflict", "The journal was updated elsewhere", 409);
  }
  await validateReferences(database, input);
  const retainedCropIds = new Set(input.sections.map((section) => section.crop_id));
  const removedCropWithPhotos = existing.sections.find(
    (section) => !retainedCropIds.has(section.crop_id) && section.photos.length > 0
  );
  if (removedCropWithPhotos) {
    throw new JournalRequestError(
      "crop_photos_exist",
      `${removedCropWithPhotos.crop_name} 사진을 먼저 삭제해 주세요`,
      409
    );
  }
  const timestamp = now.toISOString();
  const statements = [database.prepare(`
    UPDATE journal_days SET journal_date = ?1, common_note = ?2, visibility = ?3,
      revision = revision + 1, updated_at = ?4
    WHERE id = ?5 AND revision = ?6 AND deleted_at IS NULL
  `).bind(input.journal_date, input.common_note, input.visibility, timestamp, id, input.revision)];
  statements.push(...replacementStatements(database, id, input, timestamp, timestamp));
  statements.push(database.prepare(`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
    SELECT 'admin', ?1, 'journal.update', 'journal_day', ?2, ?3
    WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?2 AND updated_at = ?3)
  `).bind(actor, id, timestamp));
  const results = await database.batch(statements);
  if (Number(results?.[0]?.meta?.changes ?? 0) === 0) {
    throw new JournalRequestError("revision_conflict", "The journal was updated elsewhere", 409);
  }
  return journalDay(database, id);
}

export async function deleteJournalDay(database, id, actor, now = new Date()) {
  const timestamp = now.toISOString();
  const result = await database.batch([
    database.prepare(`
      UPDATE journal_days SET deleted_at = ?1, updated_at = ?1, revision = revision + 1
      WHERE id = ?2 AND site_id = ?3 AND deleted_at IS NULL
    `).bind(timestamp, id, SITE_ID),
    database.prepare(`
      DELETE FROM journal_photos WHERE journal_day_id = ?1
        AND EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND deleted_at = ?2)
    `).bind(id, timestamp),
    database.prepare(`
      DELETE FROM journal_crop_photos WHERE journal_day_id = ?1
        AND EXISTS (SELECT 1 FROM journal_days WHERE id = ?1 AND deleted_at = ?2)
    `).bind(id, timestamp),
    database.prepare(`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
      SELECT 'admin', ?1, 'journal.delete', 'journal_day', ?2, ?3
      WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?2 AND deleted_at = ?3)
    `).bind(actor, id, timestamp)
  ]);
  return Number(result?.[0]?.meta?.changes ?? 0) > 0;
}
