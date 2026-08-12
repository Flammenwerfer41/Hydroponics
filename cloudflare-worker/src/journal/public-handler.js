import { JournalRequestError, parseJournalListQuery } from "./contract.js";
import {
  listPublicJournalDays,
  publicJournalCatalog,
  publicJournalCropPhotoObject,
  publicJournalDay,
  publicJournalPhotoObject
} from "./store.js";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function error(code, message, status = 400) {
  return json({ schema_version: 1, error: { code, message } }, status);
}

function journalId(path) {
  return path.match(/^\/api\/journal\/([a-f0-9-]{36})$/)?.[1] ?? null;
}

function photoRoute(path) {
  return path.match(/^\/api\/journal\/([a-f0-9-]{36})\/photo$/)?.[1] ?? null;
}

function cropPhotoRoute(path) {
  const match = path.match(
    /^\/api\/journal\/([a-f0-9-]{36})\/crops\/([a-z0-9][a-z0-9-]{1,63})\/photos\/([a-f0-9-]{36})$/
  );
  return match ? { journalId: match[1], cropId: match[2], photoId: match[3] } : null;
}

async function photoResponse(bucket, metadata, request) {
  if (!bucket) return error("photo_storage_unavailable", "Photo storage is unavailable", 503);
  if (!metadata) return error("not_found", "Journal photo not found", 404);
  const variant = new URL(request.url).searchParams.get("variant") || "full";
  if (!new Set(["full", "thumbnail"]).has(variant)) {
    return error("invalid_variant", "variant must be full or thumbnail");
  }
  const key = variant === "thumbnail" ? metadata.thumbnail_object_key : metadata.full_object_key;
  const object = await bucket.get(key);
  if (!object) return error("not_found", "Journal photo object not found", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": metadata.mime_type,
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function handlePublicJournal(request, environment, path) {
  if (request.method !== "GET") {
    return error("method_not_allowed", "Only GET is supported", 405);
  }
  if (!environment.HYDROPONICS_DB) return error("database_unavailable", "Database unavailable", 503);

  try {
    if (path === "/api/journal/meta") {
      return json({ schema_version: 1, ...(await publicJournalCatalog(environment.HYDROPONICS_DB)) });
    }
    if (path === "/api/journal") {
      const query = parseJournalListQuery(new URL(request.url));
      return json({
        schema_version: 1,
        query,
        entries: await listPublicJournalDays(environment.HYDROPONICS_DB, query)
      });
    }
    const cropPhoto = cropPhotoRoute(path);
    if (cropPhoto) {
      const metadata = await publicJournalCropPhotoObject(
        environment.HYDROPONICS_DB,
        cropPhoto.journalId,
        cropPhoto.cropId,
        cropPhoto.photoId
      );
      return photoResponse(environment.JOURNAL_PHOTOS, metadata, request);
    }
    const photoId = photoRoute(path);
    if (photoId) {
      return photoResponse(
        environment.JOURNAL_PHOTOS,
        await publicJournalPhotoObject(environment.HYDROPONICS_DB, photoId),
        request
      );
    }
    const id = journalId(path);
    if (id) {
      const entry = await publicJournalDay(environment.HYDROPONICS_DB, id);
      return entry ? json({ schema_version: 1, entry }) : error("not_found", "Journal not found", 404);
    }
    return error("not_found", "Journal route not found", 404);
  } catch (caught) {
    if (caught instanceof JournalRequestError) return error(caught.code, caught.message, caught.status);
    console.error("Public journal request failed", caught);
    return error("journal_failed", "Journal request failed", 500);
  }
}
