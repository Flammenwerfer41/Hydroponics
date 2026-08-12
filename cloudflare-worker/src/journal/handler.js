import { authenticateAdmin } from "../admin/access.js";
import { jsonResponse } from "../http/response.js";
import { JournalRequestError, parseJournalInput, parseJournalListQuery } from "./contract.js";
import { parsePhotoUpload, photoExtension } from "./photo.js";
import { removeJournalObjects, removeManyJournalObjects } from "./cleanup.js";
import {
  attachJournalCropPhoto,
  attachJournalPhoto,
  createJournalDay,
  deleteJournalDay,
  journalAllPhotoObjects,
  journalCatalog,
  journalCropPhotoObject,
  journalDay,
  journalPhotoObject,
  listJournalDays,
  removeJournalCropPhoto,
  removeJournalPhoto,
  updateJournalDay
} from "./store.js";

function response(body, status = 200, headers = {}) {
  return jsonResponse(body, status, { "Cache-Control": "no-store", ...headers });
}

function error(code, message, status = 400) {
  return response({ schema_version: 1, error: { code, message } }, status);
}

async function jsonBody(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new JournalRequestError("unsupported_media_type", "Content-Type must be application/json", 415);
  }
  try {
    return await request.json();
  } catch {
    throw new JournalRequestError("invalid_json", "Request body is not valid JSON", 400);
  }
}

function resourceId(path) {
  const match = path.match(/^\/admin\/api\/journal\/([a-f0-9-]{36})$/);
  return match?.[1] ?? null;
}

function photoResourceId(path) {
  const match = path.match(/^\/admin\/api\/journal\/([a-f0-9-]{36})\/photo$/);
  return match?.[1] ?? null;
}

function cropPhotoCollection(path) {
  const match = path.match(
    /^\/admin\/api\/journal\/([a-f0-9-]{36})\/crops\/([a-z0-9][a-z0-9-]{1,63})\/photos$/
  );
  return match ? { journalId: match[1], cropId: match[2] } : null;
}

function cropPhotoResource(path) {
  const match = path.match(
    /^\/admin\/api\/journal\/([a-f0-9-]{36})\/crops\/([a-z0-9][a-z0-9-]{1,63})\/photos\/([a-f0-9-]{36})$/
  );
  return match ? { journalId: match[1], cropId: match[2], photoId: match[3] } : null;
}

function revisionHeader(request) {
  const raw = request.headers.get("X-Journal-Revision");
  if (!/^\d+$/.test(raw || "") || Number(raw) < 1) {
    throw new JournalRequestError(
      "invalid_revision",
      "X-Journal-Revision must be a positive integer"
    );
  }
  return Number(raw);
}

async function photoBody(database, bucket, id, request) {
  if (!bucket) return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
  const metadata = await journalPhotoObject(database, id);
  if (!metadata) return error("not_found", "Journal photo not found", 404);
  const variant = new URL(request.url).searchParams.get("variant") || "full";
  if (!["full", "thumbnail"].includes(variant)) {
    return error("invalid_variant", "variant must be full or thumbnail");
  }
  const key = variant === "thumbnail" ? metadata.thumbnail_object_key : metadata.full_object_key;
  const object = await bucket.get(key);
  if (!object) return error("not_found", "Journal photo object not found", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": metadata.mime_type,
      "Content-Length": String(object.size),
      "Cache-Control": "private, max-age=3600",
      "ETag": object.httpEtag,
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function storedPhotoBody(bucket, metadata, request) {
  if (!bucket) return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
  if (!metadata) return error("not_found", "Journal photo not found", 404);
  const variant = new URL(request.url).searchParams.get("variant") || "full";
  if (!["full", "thumbnail"].includes(variant)) {
    return error("invalid_variant", "variant must be full or thumbnail");
  }
  const key = variant === "thumbnail" ? metadata.thumbnail_object_key : metadata.full_object_key;
  const object = await bucket.get(key);
  if (!object) return error("not_found", "Journal photo object not found", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": metadata.mime_type,
      "Content-Length": String(object.size),
      "Cache-Control": "private, max-age=3600",
      "ETag": object.httpEtag,
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function putPhoto(database, bucket, id, request, actor) {
  if (!bucket) return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new JournalRequestError(
      "unsupported_media_type",
      "Photo upload must use multipart/form-data",
      415
    );
  }
  const existingEntry = await journalDay(database, id);
  if (!existingEntry) return error("not_found", "Journal not found", 404);
  const previous = await journalPhotoObject(database, id);
  let upload;
  try {
    upload = parsePhotoUpload(await request.formData());
  } catch (caught) {
    if (caught instanceof JournalRequestError) throw caught;
    throw new JournalRequestError("invalid_photo", "Photo form could not be read");
  }

  const version = crypto.randomUUID();
  const extension = photoExtension(upload.mimeType);
  const fullObjectKey = `journal/${id}/${version}/photo.${extension}`;
  const thumbnailObjectKey = `journal/${id}/${version}/thumbnail.${extension}`;
  const metadata = { journalId: id, uploadedBy: actor };
  try {
    await bucket.put(fullObjectKey, upload.photo, {
      httpMetadata: { contentType: upload.mimeType },
      customMetadata: metadata
    });
    await bucket.put(thumbnailObjectKey, upload.thumbnail, {
      httpMetadata: { contentType: upload.mimeType },
      customMetadata: metadata
    });
    const entry = await attachJournalPhoto(database, id, {
      fullObjectKey,
      thumbnailObjectKey,
      mimeType: upload.mimeType,
      byteSize: upload.photo.size,
      thumbnailByteSize: upload.thumbnail.size,
      width: upload.width,
      height: upload.height
    }, actor, upload.revision);
    await removeJournalObjects(database, bucket, previous, "journal_cover_replaced");
    return response({ schema_version: 1, entry });
  } catch (caught) {
    await removeJournalObjects(database, bucket, {
      full_object_key: fullObjectKey,
      thumbnail_object_key: thumbnailObjectKey
    }, "journal_cover_upload_rollback");
    throw caught;
  }
}

async function postCropPhoto(database, bucket, route, request, actor) {
  if (!bucket) return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new JournalRequestError("unsupported_media_type", "Photo upload must use multipart/form-data", 415);
  }
  let upload;
  try {
    upload = parsePhotoUpload(await request.formData());
  } catch (caught) {
    if (caught instanceof JournalRequestError) throw caught;
    throw new JournalRequestError("invalid_photo", "Photo form could not be read");
  }
  const version = crypto.randomUUID();
  const extension = photoExtension(upload.mimeType);
  const base = `journal/${route.journalId}/crops/${route.cropId}/${version}`;
  const fullObjectKey = `${base}/photo.${extension}`;
  const thumbnailObjectKey = `${base}/thumbnail.${extension}`;
  const metadata = { journalId: route.journalId, cropId: route.cropId, uploadedBy: actor };
  try {
    await bucket.put(fullObjectKey, upload.photo, {
      httpMetadata: { contentType: upload.mimeType }, customMetadata: metadata
    });
    await bucket.put(thumbnailObjectKey, upload.thumbnail, {
      httpMetadata: { contentType: upload.mimeType }, customMetadata: metadata
    });
    const entry = await attachJournalCropPhoto(database, route.journalId, route.cropId, {
      fullObjectKey,
      thumbnailObjectKey,
      mimeType: upload.mimeType,
      byteSize: upload.photo.size,
      thumbnailByteSize: upload.thumbnail.size,
      width: upload.width,
      height: upload.height
    }, actor, upload.revision);
    if (!entry) throw new JournalRequestError("not_found", "Journal not found", 404);
    return response({ schema_version: 1, entry }, 201);
  } catch (caught) {
    await removeJournalObjects(database, bucket, {
      full_object_key: fullObjectKey,
      thumbnail_object_key: thumbnailObjectKey
    }, "journal_crop_upload_rollback");
    throw caught;
  }
}

export async function handleJournalAdmin(request, environment, path) {
  if (!environment.HYDROPONICS_DB) return error("database_unavailable", "Database unavailable", 503);
  const admin = await authenticateAdmin(request, environment);
  if (!admin) return error("unauthorized", "Cloudflare Access authentication is required", 401);
  const actor = admin.email || admin.id;
  const id = resourceId(path);
  const photoId = photoResourceId(path);
  const cropPhotoList = cropPhotoCollection(path);
  const cropPhoto = cropPhotoResource(path);

  try {
    if (request.method === "GET" && cropPhoto) {
      const metadata = await journalCropPhotoObject(
        environment.HYDROPONICS_DB,
        cropPhoto.journalId,
        cropPhoto.cropId,
        cropPhoto.photoId
      );
      return storedPhotoBody(environment.JOURNAL_PHOTOS, metadata, request);
    }
    if (request.method === "POST" && cropPhotoList) {
      return postCropPhoto(
        environment.HYDROPONICS_DB,
        environment.JOURNAL_PHOTOS,
        cropPhotoList,
        request,
        actor
      );
    }
    if (request.method === "DELETE" && cropPhoto) {
      if (!environment.JOURNAL_PHOTOS) {
        return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
      }
      const previous = await journalCropPhotoObject(
        environment.HYDROPONICS_DB,
        cropPhoto.journalId,
        cropPhoto.cropId,
        cropPhoto.photoId
      );
      if (!previous) return error("not_found", "Journal photo not found", 404);
      const entry = await removeJournalCropPhoto(
        environment.HYDROPONICS_DB,
        cropPhoto.journalId,
        cropPhoto.cropId,
        cropPhoto.photoId,
        actor,
        revisionHeader(request)
      );
      await removeJournalObjects(
        environment.HYDROPONICS_DB,
        environment.JOURNAL_PHOTOS,
        previous,
        "journal_crop_photo_removed"
      );
      return response({ schema_version: 1, entry });
    }
    if (request.method === "GET" && photoId) {
      return photoBody(environment.HYDROPONICS_DB, environment.JOURNAL_PHOTOS, photoId, request);
    }
    if (request.method === "PUT" && photoId) {
      return putPhoto(
        environment.HYDROPONICS_DB,
        environment.JOURNAL_PHOTOS,
        photoId,
        request,
        actor
      );
    }
    if (request.method === "DELETE" && photoId) {
      if (!environment.JOURNAL_PHOTOS) {
        return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
      }
      const previous = await journalPhotoObject(environment.HYDROPONICS_DB, photoId);
      if (!previous) return error("not_found", "Journal photo not found", 404);
      const entry = await removeJournalPhoto(
        environment.HYDROPONICS_DB,
        photoId,
        actor,
        revisionHeader(request)
      );
      await removeJournalObjects(
        environment.HYDROPONICS_DB,
        environment.JOURNAL_PHOTOS,
        previous,
        "journal_cover_removed"
      );
      return response({ schema_version: 1, entry });
    }
    if (request.method === "GET" && path === "/admin/api/journal/meta") {
      return response({ schema_version: 1, ...(await journalCatalog(environment.HYDROPONICS_DB)) });
    }
    if (request.method === "GET" && path === "/admin/api/journal") {
      const query = parseJournalListQuery(new URL(request.url));
      return response({
        schema_version: 1,
        query,
        entries: await listJournalDays(environment.HYDROPONICS_DB, query)
      });
    }
    if (request.method === "GET" && id) {
      const entry = await journalDay(environment.HYDROPONICS_DB, id);
      return entry ? response({ schema_version: 1, entry }) : error("not_found", "Journal not found", 404);
    }
    if (request.method === "POST" && path === "/admin/api/journal") {
      const input = parseJournalInput(await jsonBody(request));
      const entry = await createJournalDay(environment.HYDROPONICS_DB, input, actor);
      return response({ schema_version: 1, entry }, 201);
    }
    if (request.method === "PUT" && id) {
      const input = parseJournalInput(await jsonBody(request));
      const entry = await updateJournalDay(environment.HYDROPONICS_DB, id, input, actor);
      return entry ? response({ schema_version: 1, entry }) : error("not_found", "Journal not found", 404);
    }
    if (request.method === "DELETE" && id) {
      const photos = await journalAllPhotoObjects(environment.HYDROPONICS_DB, id);
      const deleted = await deleteJournalDay(environment.HYDROPONICS_DB, id, actor);
      if (deleted) await removeManyJournalObjects(
        environment.HYDROPONICS_DB,
        environment.JOURNAL_PHOTOS,
        photos,
        "journal_deleted"
      );
      return deleted ? response({ schema_version: 1, deleted: true }) : error("not_found", "Journal not found", 404);
    }
    return error("not_found", "Journal route not found", 404);
  } catch (caught) {
    if (caught instanceof JournalRequestError) {
      return error(caught.code, caught.message, caught.status);
    }
    if (/UNIQUE constraint failed: journal_days/i.test(caught?.message || "")) {
      return error("date_conflict", "A journal already exists for that date", 409);
    }
    console.error("Journal request failed", caught);
    return error("journal_failed", "Journal request failed", 500);
  }
}
