import { JOURNAL_UNITS, JournalRequestError } from "./contract.js";

const SITE_ID = "home-lab";
const ZONE_ID = "tower-01";

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function dateRange(query) {
  const start = `${query.year}-${String(query.month).padStart(2, "0")}-${String(query.day ?? 1).padStart(2, "0")}`;
  if (query.day !== null) {
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return [start, end.toISOString().slice(0, 10)];
  }
  const end = new Date(Date.UTC(query.year, query.month, 1));
  return [start, end.toISOString().slice(0, 10)];
}

function valueMap(valueRows) {
  const output = {};
  for (const row of valueRows) {
    output[row.metric] = {
      value: row.value,
      unit: row.unit,
      source: row.source,
      qualifier: row.qualifier,
      measured_at: row.measured_at
    };
  }
  return output;
}

export async function journalCatalog(database) {
  const [cropResult, tagResult, periodResult] = await Promise.all([
    database.prepare(`
      SELECT id, common_name, scientific_name, cultivar
      FROM crops
      WHERE id IN ('crop-basil', 'crop-perilla')
      ORDER BY common_name
    `).all(),
    database.prepare(`
      SELECT id, name, slug, kind, color
      FROM journal_tags
      WHERE site_id = ?1 AND active = 1
      ORDER BY kind, name
    `).bind(SITE_ID).all(),
    database.prepare(`
      SELECT substr(journal_date, 1, 4) AS year,
        substr(journal_date, 6, 2) AS month, COUNT(*) AS count
      FROM journal_days
      WHERE site_id = ?1 AND deleted_at IS NULL
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `).bind(SITE_ID).all()
  ]);
  return { crops: rows(cropResult), tags: rows(tagResult), periods: rows(periodResult) };
}

export async function listJournalDays(database, query) {
  const [from, to] = dateRange(query);
  const result = await database.prepare(`
    SELECT jd.id, jd.journal_date, jd.common_note, jd.visibility, jd.revision,
      jd.updated_at,
      GROUP_CONCAT(DISTINCT c.common_name) AS crop_names,
      COUNT(DISTINCT js.id) AS section_count,
      (SELECT value FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'solution_ph') AS solution_ph,
      (SELECT value FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'electrical_conductivity') AS electrical_conductivity,
      (SELECT value FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'solution_added_volume') AS solution_added_volume,
      (SELECT qualifier FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'solution_added_volume') AS solution_added_liquid_type
    FROM journal_days jd
    LEFT JOIN journal_sections js ON js.journal_day_id = jd.id
    LEFT JOIN crops c ON c.id = js.crop_id
    WHERE jd.site_id = ?1 AND jd.deleted_at IS NULL
      AND jd.journal_date >= ?2 AND jd.journal_date < ?3
      AND (?4 IS NULL OR EXISTS (
        SELECT 1 FROM journal_sections crop_section
        WHERE crop_section.journal_day_id = jd.id AND crop_section.crop_id = ?4
      ))
      AND (?5 IS NULL OR EXISTS (
        SELECT 1 FROM journal_sections tag_section
        JOIN journal_section_tags selected_tag ON selected_tag.journal_section_id = tag_section.id
        WHERE tag_section.journal_day_id = jd.id AND selected_tag.tag_id = ?5
      ))
    GROUP BY jd.id
    ORDER BY jd.journal_date DESC, jd.updated_at DESC
    LIMIT ?6
  `).bind(SITE_ID, from, to, query.cropId, query.tagId, query.limit).all();
  return rows(result).map((row) => ({
    ...row,
    crop_names: row.crop_names ? row.crop_names.split(",") : []
  }));
}

export async function journalDay(database, id) {
  const day = await database.prepare(`
    SELECT id, site_id, zone_id, journal_date, common_note, visibility,
      revision, created_by, created_at, updated_at
    FROM journal_days
    WHERE id = ?1 AND site_id = ?2 AND deleted_at IS NULL
  `).bind(id, SITE_ID).first();
  if (!day) return null;
  const [valueResult, sectionResult, tagResult] = await Promise.all([
    database.prepare(`
      SELECT metric, value, unit, source, qualifier, measured_at
      FROM journal_day_values WHERE journal_day_id = ?1 ORDER BY metric
    `).bind(id).all(),
    database.prepare(`
      SELECT js.id, js.crop_id, c.common_name AS crop_name, js.title, js.body,
        js.sort_order, js.created_at, js.updated_at
      FROM journal_sections js JOIN crops c ON c.id = js.crop_id
      WHERE js.journal_day_id = ?1 ORDER BY js.sort_order, js.id
    `).bind(id).all(),
    database.prepare(`
      SELECT jst.journal_section_id, jt.id, jt.name, jt.slug, jt.kind, jt.color
      FROM journal_section_tags jst JOIN journal_tags jt ON jt.id = jst.tag_id
      JOIN journal_sections js ON js.id = jst.journal_section_id
      WHERE js.journal_day_id = ?1 ORDER BY jt.name
    `).bind(id).all()
  ]);
  const tagsBySection = new Map();
  for (const tag of rows(tagResult)) {
    const list = tagsBySection.get(tag.journal_section_id) ?? [];
    const { journal_section_id: ignored, ...publicTag } = tag;
    list.push(publicTag);
    tagsBySection.set(tag.journal_section_id, list);
  }
  return {
    ...day,
    measurements: valueMap(rows(valueResult)),
    sections: rows(sectionResult).map((section) => ({
      ...section,
      tags: tagsBySection.get(section.id) ?? []
    }))
  };
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
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, occurred_at)
      SELECT 'admin', ?1, 'journal.delete', 'journal_day', ?2, ?3
      WHERE EXISTS (SELECT 1 FROM journal_days WHERE id = ?2 AND deleted_at = ?3)
    `).bind(actor, id, timestamp)
  ]);
  return Number(result?.[0]?.meta?.changes ?? 0) > 0;
}
