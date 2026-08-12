import { METRICS } from "../ingestion/contract.js";
import { authenticateAdmin } from "../admin/access.js";
import { jsonResponse as sharedJsonResponse, publicCorsHeaders } from "../http/response.js";
import {
  HISTORY_SCHEMA_VERSION,
  HISTORY_TIMEZONE,
  HistoryRequestError,
  parseHistoryQuery,
  publicQuery
} from "./contract.js";
import {
  exportRowsToCsv,
  exportRowsToReadings,
  queryAggregates,
  queryExportRows,
  queryLatestReading,
  queryRawReadings
} from "./query.js";

const ROUTES = Object.freeze({
  "/v1/readings/latest": "latest",
  "/v1/readings": "raw",
  "/v1/history/hourly": "hourly",
  "/v1/history/daily": "daily"
});

const ADMIN_EXPORT_ROUTES = Object.freeze({
  "/admin/api/export.json": "export-json",
  "/admin/api/export.csv": "export-csv"
});

const CACHE_SECONDS = Object.freeze({
  latest: 30,
  raw: 30,
  hourly: 5 * 60,
  daily: 15 * 60
});

const CORS_HEADERS = Object.freeze({
  ...publicCorsHeaders()
});

function jsonResponse(body, status = 200, headers = {}) {
  return sharedJsonResponse(body, status, { ...CORS_HEADERS, ...headers });
}

function errorResponse(code, message, status = 400) {
  return jsonResponse({
    schema_version: HISTORY_SCHEMA_VERSION,
    error: { code, message }
  }, status, { "Cache-Control": "no-store" });
}

function generatedEnvelope(query, includeIdentity = false) {
  const queryMetadata = publicQuery(query);
  if (!includeIdentity) {
    delete queryMetadata.site_id;
    delete queryMetadata.zone_id;
    delete queryMetadata.device_id;
  }
  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    timezone: HISTORY_TIMEZONE,
    query: queryMetadata,
    units: Object.fromEntries(query.metrics.map((metric) => [metric, METRICS[metric].unit]))
  };
}

function publicReading(reading) {
  if (!reading) return null;
  return {
    measured_at: reading.measured_at,
    values: reading.values,
    quality: reading.quality,
    diagnostics: reading.diagnostics
  };
}

function publicBucket(bucket) {
  return {
    start: bucket.start,
    end: bucket.end,
    metrics: bucket.metrics
  };
}

function canonicalCacheKey(request) {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) =>
    leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [name, value] of entries) url.searchParams.append(name, value);
  return new Request(url.toString(), { method: "GET" });
}

async function cachedResponse(request, context, seconds, createResponse) {
  const cache = globalThis.caches?.default;
  if (!cache || !context?.waitUntil) {
    const response = await createResponse();
    response.headers.set("X-Data-Cache", "BYPASS");
    return response;
  }
  const key = canonicalCacheKey(request);
  const cached = await cache.match(key);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("X-Data-Cache", "HIT");
    return response;
  }
  const response = await createResponse();
  response.headers.set("X-Data-Cache", "MISS");
  context.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function latestResponse(database, query) {
  const reading = await queryLatestReading(database, query);
  return jsonResponse({ ...generatedEnvelope(query), reading: publicReading(reading) }, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS.latest}`
  });
}

async function rawResponse(database, query) {
  const result = await queryRawReadings(database, query);
  return jsonResponse({
    ...generatedEnvelope(query),
    readings: result.readings.map(publicReading),
    page: {
      count: result.readings.length,
      next_cursor: result.nextCursor
    }
  }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS.raw}` });
}

async function aggregateResponse(database, query, granularity) {
  const buckets = await queryAggregates(database, query, granularity);
  return jsonResponse({
    ...generatedEnvelope(query),
    granularity,
    buckets: buckets.map(publicBucket)
  }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS[granularity]}` });
}

function exportFilename(query, extension) {
  const localDate = (timestamp) => new Date(Date.parse(timestamp) + 9 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const from = localDate(query.from);
  const to = localDate(new Date(Date.parse(query.to) - 1).toISOString());
  return `hydroponics-${from}-${to}.${extension}`;
}

async function exportResponse(database, query, format) {
  const rows = await queryExportRows(database, query);
  if (format === "csv") {
    return new Response(exportRowsToCsv(rows, query.metrics), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(query, "csv")}"`,
        "Cache-Control": "no-store"
      }
    });
  }
  const readings = exportRowsToReadings(rows, query.metrics);
  return jsonResponse({
    ...generatedEnvelope(query, true),
    count: readings.length,
    readings
  }, 200, {
    "Content-Disposition": `attachment; filename="${exportFilename(query, "json")}"`,
    "Cache-Control": "no-store"
  });
}

export function isHistoryRoute(path) {
  return Object.hasOwn(ROUTES, path);
}

export function isAdminExportRoute(path) {
  return Object.hasOwn(ADMIN_EXPORT_ROUTES, path);
}

export async function handleHistory(request, environment, context, path) {
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed", 405);
  }
  if (!environment.HYDROPONICS_DB) {
    return errorResponse("database_unavailable", "Measurement database is unavailable", 503);
  }

  const route = ROUTES[path];
  try {
    if (route === "latest") {
      const query = parseHistoryQuery(new URL(request.url), "latest");
      return cachedResponse(request, context, CACHE_SECONDS.latest,
        () => latestResponse(environment.HYDROPONICS_DB, query));
    }
    if (route === "raw") {
      const query = parseHistoryQuery(new URL(request.url), "raw");
      return cachedResponse(request, context, CACHE_SECONDS.raw,
        () => rawResponse(environment.HYDROPONICS_DB, query));
    }
    if (route === "hourly" || route === "daily") {
      const query = parseHistoryQuery(new URL(request.url), route);
      return cachedResponse(request, context, CACHE_SECONDS[route],
        () => aggregateResponse(environment.HYDROPONICS_DB, query, route));
    }
    return errorResponse("not_found", "Not found", 404);
  } catch (error) {
    if (error instanceof HistoryRequestError || error?.code === "export_too_large") {
      return errorResponse(error.code, error.message, error.status ?? 400);
    }
    console.error("Measurement history query failed", error);
    return errorResponse("history_query_failed", "Measurement history is temporarily unavailable", 500);
  }
}

export async function handleAdminExport(
  request,
  environment,
  path,
  authenticate = authenticateAdmin
) {
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Method not allowed", 405);
  }
  if (!environment.HYDROPONICS_DB) {
    return errorResponse("database_unavailable", "Measurement database is unavailable", 503);
  }
  if (!(await authenticate(request, environment))) {
    return errorResponse("unauthorized", "Cloudflare Access authentication is required", 401);
  }

  const route = ADMIN_EXPORT_ROUTES[path];
  try {
    const query = parseHistoryQuery(new URL(request.url), "export");
    return exportResponse(
      environment.HYDROPONICS_DB,
      query,
      route === "export-csv" ? "csv" : "json"
    );
  } catch (error) {
    if (error instanceof HistoryRequestError || error?.code === "export_too_large") {
      return errorResponse(error.code, error.message, error.status ?? 400);
    }
    console.error("Measurement export failed", error);
    return errorResponse("export_failed", "Measurement export is temporarily unavailable", 500);
  }
}
