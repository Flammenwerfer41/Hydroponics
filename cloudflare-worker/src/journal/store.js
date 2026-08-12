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

function photoMetadata(row, routePrefix = "/admin/api/journal") {
  if (!row?.photo_mime_type) return null;
  return {
    mime_type: row.photo_mime_type,
    byte_size: row.photo_byte_size,
    width: row.photo_width,
    height: row.photo_height,
    updated_at: row.photo_updated_at,
    url: `${routePrefix}/${row.id}/photo`,
    thumbnail_url: `${routePrefix}/${row.id}/photo?variant=thumbnail`
  };
}

function cropPhotoMetadata(row, journalId, routePrefix = "/admin/api/journal") {
  return {
    id: row.id,
    crop_id: row.crop_id,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    width: row.width,
    height: row.height,
    sort_order: row.sort_order,
    updated_at: row.updated_at,
    url: `${routePrefix}/${journalId}/crops/${row.crop_id}/photos/${row.id}`,
    thumbnail_url: `${routePrefix}/${journalId}/crops/${row.crop_id}/photos/${row.id}?variant=thumbnail`
  };
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

export async function publicJournalCatalog(database) {
  const [cropResult, tagResult, periodResult] = await Promise.all([
    database.prepare(`
      SELECT DISTINCT c.id, c.common_name, c.scientific_name, c.cultivar
      FROM crops c JOIN journal_sections js ON js.crop_id = c.id
      JOIN journal_days jd ON jd.id = js.journal_day_id
      WHERE jd.site_id = ?1 AND jd.visibility = 'public' AND jd.deleted_at IS NULL
      ORDER BY c.common_name
    `).bind(SITE_ID).all(),
    database.prepare(`
      SELECT DISTINCT jt.id, jt.name, jt.slug, jt.kind, jt.color
      FROM journal_tags jt JOIN journal_section_tags jst ON jst.tag_id = jt.id
      JOIN journal_sections js ON js.id = jst.journal_section_id
      JOIN journal_days jd ON jd.id = js.journal_day_id
      WHERE jd.site_id = ?1 AND jd.visibility = 'public' AND jd.deleted_at IS NULL
      ORDER BY jt.kind, jt.name
    `).bind(SITE_ID).all(),
    database.prepare(`
      SELECT substr(journal_date, 1, 4) AS year,
        substr(journal_date, 6, 2) AS month, COUNT(*) AS count
      FROM journal_days
      WHERE site_id = ?1 AND visibility = 'public' AND deleted_at IS NULL
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `).bind(SITE_ID).all()
  ]);
  return { crops: rows(cropResult), tags: rows(tagResult), periods: rows(periodResult) };
}

async function listJournalDaysWithVisibility(database, query, visibility = null) {
  const [from, to] = dateRange(query);
  const result = await database.prepare(`
    SELECT jd.id, jd.journal_date, jd.common_note, jd.visibility, jd.revision,
      jd.updated_at,
      GROUP_CONCAT(DISTINCT c.common_name) AS crop_names,
      COUNT(DISTINCT js.id) AS section_count,
      (SELECT value FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'solution_ph') AS solution_ph,
      (SELECT value FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'electrical_conductivity') AS electrical_conductivity,
      (SELECT value FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'solution_added_volume') AS solution_added_volume,
      (SELECT qualifier FROM journal_day_values WHERE journal_day_id = jd.id AND metric = 'solution_added_volume') AS solution_added_liquid_type,
      (SELECT mime_type FROM journal_photos WHERE journal_day_id = jd.id) AS photo_mime_type,
      (SELECT byte_size FROM journal_photos WHERE journal_day_id = jd.id) AS photo_byte_size,
      (SELECT width FROM journal_photos WHERE journal_day_id = jd.id) AS photo_width,
      (SELECT height FROM journal_photos WHERE journal_day_id = jd.id) AS photo_height,
      (SELECT updated_at FROM journal_photos WHERE journal_day_id = jd.id) AS photo_updated_at
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
      AND (?6 IS NULL OR jd.visibility = ?6)
    GROUP BY jd.id
    ORDER BY jd.journal_date DESC, jd.updated_at DESC
    LIMIT ?7
  `).bind(SITE_ID, from, to, query.cropId, query.tagId, visibility, query.limit).all();
  return rows(result).map((row) => {
    const photo = photoMetadata(row);
    const {
      photo_mime_type: ignoredMime,
      photo_byte_size: ignoredBytes,
      photo_width: ignoredWidth,
      photo_height: ignoredHeight,
      photo_updated_at: ignoredUpdated,
      ...entry
    } = row;
    return {
      ...entry,
      crop_names: row.crop_names ? row.crop_names.split(",") : [],
      photo
    };
  });
}

export async function listJournalDays(database, query) {
  return listJournalDaysWithVisibility(database, query);
}

export async function listPublicJournalDays(database, query) {
  const entries = await listJournalDaysWithVisibility(database, query, "public");
  return entries.map((entry) => ({
    id: entry.id,
    journal_date: entry.journal_date,
    common_note: entry.common_note,
    updated_at: entry.updated_at,
    crop_names: entry.crop_names,
    section_count: entry.section_count,
    solution_ph: entry.solution_ph,
    electrical_conductivity: entry.electrical_conductivity,
    solution_added_volume: entry.solution_added_volume,
    solution_added_liquid_type: entry.solution_added_liquid_type,
    photo: entry.photo ? {
      ...entry.photo,
      url: `/api/journal/${entry.id}/photo`,
      thumbnail_url: `/api/journal/${entry.id}/photo?variant=thumbnail`
    } : null
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
  const [valueResult, sectionResult, tagResult, photo, cropPhotoResult] = await Promise.all([
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
    `).bind(id).all(),
    database.prepare(`
      SELECT mime_type AS photo_mime_type, byte_size AS photo_byte_size,
        width AS photo_width, height AS photo_height, updated_at AS photo_updated_at
      FROM journal_photos WHERE journal_day_id = ?1
    `).bind(id).first(),
    database.prepare(`
      SELECT id, crop_id, mime_type, byte_size, width, height, sort_order, updated_at
      FROM journal_crop_photos
      WHERE journal_day_id = ?1
      ORDER BY crop_id, sort_order, created_at
    `).bind(id).all()
  ]);
  const tagsBySection = new Map();
  for (const tag of rows(tagResult)) {
    const list = tagsBySection.get(tag.journal_section_id) ?? [];
    const { journal_section_id: ignored, ...publicTag } = tag;
    list.push(publicTag);
    tagsBySection.set(tag.journal_section_id, list);
  }
  const photosByCrop = new Map();
  for (const row of rows(cropPhotoResult)) {
    const list = photosByCrop.get(row.crop_id) ?? [];
    list.push(cropPhotoMetadata(row, id));
    photosByCrop.set(row.crop_id, list);
  }
  return {
    ...day,
    photo: photoMetadata({ ...photo, id }),
    measurements: valueMap(rows(valueResult)),
    sections: rows(sectionResult).map((section) => ({
      ...section,
      tags: tagsBySection.get(section.id) ?? [],
      photos: photosByCrop.get(section.crop_id) ?? []
    }))
  };
}

export async function publicJournalDay(database, id) {
  const visibility = await database.prepare(`
    SELECT visibility FROM journal_days
    WHERE id = ?1 AND site_id = ?2 AND deleted_at IS NULL
  `).bind(id, SITE_ID).first();
  if (visibility?.visibility !== "public") return null;
  const entry = await journalDay(database, id);
  if (!entry) return null;
  return {
    id: entry.id,
    journal_date: entry.journal_date,
    common_note: entry.common_note,
    updated_at: entry.updated_at,
    photo: entry.photo ? {
      ...entry.photo,
      url: `/api/journal/${entry.id}/photo`,
      thumbnail_url: `/api/journal/${entry.id}/photo?variant=thumbnail`
    } : null,
    measurements: Object.fromEntries(Object.entries(entry.measurements).map(([metric, value]) => [metric, {
      value: value.value,
      unit: value.unit,
      qualifier: value.qualifier,
      measured_at: value.measured_at
    }])),
    sections: entry.sections.map((section) => ({
      crop_id: section.crop_id,
      crop_name: section.crop_name,
      title: section.title,
      body: section.body,
      tags: section.tags,
      photos: section.photos.map((photo) => ({
        ...photo,
        url: `/api/journal/${entry.id}/crops/${section.crop_id}/photos/${photo.id}`,
        thumbnail_url: `/api/journal/${entry.id}/crops/${section.crop_id}/photos/${photo.id}?variant=thumbnail`
      }))
    }))
  };
}

export async function publicJournalPhotoObject(database, id) {
  return database.prepare(`
    SELECT jp.full_object_key, jp.thumbnail_object_key, jp.mime_type
    FROM journal_photos jp JOIN journal_days jd ON jd.id = jp.journal_day_id
    WHERE jp.journal_day_id = ?1 AND jd.site_id = ?2
      AND jd.visibility = 'public' AND jd.deleted_at IS NULL
  `).bind(id, SITE_ID).first();
}

export async function publicJournalCropPhotoObject(database, journalId, cropId, photoId) {
  return database.prepare(`
    SELECT jcp.full_object_key, jcp.thumbnail_object_key, jcp.mime_type
    FROM journal_crop_photos jcp JOIN journal_days jd ON jd.id = jcp.journal_day_id
    WHERE jcp.id = ?1 AND jcp.journal_day_id = ?2 AND jcp.crop_id = ?3
      AND jd.site_id = ?4 AND jd.visibility = 'public' AND jd.deleted_at IS NULL
  `).bind(photoId, journalId, cropId, SITE_ID).first();
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
