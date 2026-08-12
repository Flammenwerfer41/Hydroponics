const SITE_ID = "home-lab";

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
