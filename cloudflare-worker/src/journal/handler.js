import { authenticateAdmin } from "../admin/access.js";
import { JournalRequestError, parseJournalInput, parseJournalListQuery } from "./contract.js";
import {
  createJournalDay,
  deleteJournalDay,
  journalCatalog,
  journalDay,
  listJournalDays,
  updateJournalDay
} from "./store.js";

function response(body, status = 200, headers = {}) {
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

export async function handleJournalAdmin(request, environment, path) {
  if (!environment.HYDROPONICS_DB) return error("database_unavailable", "Database unavailable", 503);
  const admin = await authenticateAdmin(request, environment);
  if (!admin) return error("unauthorized", "Cloudflare Access authentication is required", 401);
  const actor = admin.email || admin.id;
  const id = resourceId(path);

  try {
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
      const deleted = await deleteJournalDay(environment.HYDROPONICS_DB, id, actor);
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
