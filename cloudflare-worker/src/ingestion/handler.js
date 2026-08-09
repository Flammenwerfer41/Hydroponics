import { authenticateDevice, sha256Hex } from "./auth.js";
import { ReadingValidationError, normalizeReading } from "./contract.js";
import { persistReading } from "./store.js";

const MAX_BODY_BYTES = 128 * 1024;
// D1 Free allows 50 queries per Worker invocation. Each reading uses two batched
// writes and one identity read; auth and last-seen maintenance use three more.
const MAX_BULK_READINGS = 15;

function apiResponse(body, status = 200, headers = {}) {
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

function errorResponse(code, message, status, details) {
  return apiResponse({
    error: { code, message, ...(details?.length ? { details } : {}) }
  }, status);
}

async function parseJsonBody(request) {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large"), { status: 413 });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large"), { status: 413 });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 });
  }
}

async function remoteAddressHash(request, environment) {
  const address = request.headers.get("CF-Connecting-IP");
  if (!address || !environment.AUDIT_HASH_SALT) return null;
  return sha256Hex(`${environment.AUDIT_HASH_SALT}:${address}`);
}

function validationResult(input, index, now) {
  try {
    return { index, input, reading: normalizeReading(input, now) };
  } catch (error) {
    if (!(error instanceof ReadingValidationError)) throw error;
    return {
      index,
      readingId: typeof input?.reading_id === "string" ? input.reading_id : null,
      result: {
        status: "rejected",
        reason: "validation_failed",
        details: error.details.length ? error.details : [error.message]
      }
    };
  }
}

async function processReadings(database, deviceId, inputs, request, environment, now) {
  const addressHash = await remoteAddressHash(request, environment);
  const receivedAt = now.toISOString();
  const results = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const validated = validationResult(inputs[index], index, now);
    if (validated.result) {
      results.push({
        index,
        reading_id: validated.readingId,
        ...validated.result
      });
      continue;
    }

    try {
      const result = await persistReading(
        database,
        deviceId,
        validated.reading,
        receivedAt,
        addressHash
      );
      results.push({ index, reading_id: validated.reading.readingId, ...result });
    } catch (error) {
      console.error("Reading persistence failed", error);
      results.push({
        index,
        reading_id: validated.reading.readingId,
        status: "rejected",
        reason: "storage_error"
      });
    }
  }
  return results;
}

function responseStatusFor(result) {
  if (result.status === "accepted") return 201;
  if (result.status === "duplicate") return 200;
  if (result.reason === "reading_id_conflict" || result.reason === "sequence_conflict") return 409;
  if (result.reason === "storage_error") return 503;
  return 422;
}

export function ingestionOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

export async function handleIngestion(request, environment, context, path) {
  if (request.method === "OPTIONS") return ingestionOptionsResponse();
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405);
  }
  if (!environment.HYDROPONICS_DB) {
    return errorResponse("storage_unavailable", "Measurement storage is not configured", 503);
  }

  const device = await authenticateDevice(request, environment.HYDROPONICS_DB);
  if (!device) {
    return errorResponse("unauthorized", "Valid device credentials are required", 401);
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return errorResponse(
      error.status === 413 ? "payload_too_large" : "invalid_request",
      error.message,
      error.status ?? 400
    );
  }

  const bulk = path === "/v1/readings/bulk";
  let inputs;
  if (bulk) {
    if (body?.schema_version !== 1 || !Array.isArray(body?.readings)) {
      return errorResponse(
        "invalid_envelope",
        "Bulk body must contain schema_version 1 and a readings array",
        400
      );
    }
    if (body.readings.length === 0 || body.readings.length > MAX_BULK_READINGS) {
      return errorResponse(
        "invalid_batch_size",
        `Bulk requests must contain 1-${MAX_BULK_READINGS} readings`,
        400
      );
    }
    inputs = body.readings;
  } else {
    inputs = [body];
  }

  const now = new Date();
  const results = await processReadings(
    environment.HYDROPONICS_DB,
    device.device_id,
    inputs,
    request,
    environment,
    now
  );

  const accepted = results.filter(({ status }) => status === "accepted").length;
  const duplicates = results.filter(({ status }) => status === "duplicate").length;
  const rejected = results.filter(({ status }) => status === "rejected").length;

  const maintenance = environment.HYDROPONICS_DB.prepare(`
    UPDATE devices SET last_seen_at = ?1, updated_at = ?1 WHERE id = ?2;
  `).bind(now.toISOString(), device.device_id).run().then(() =>
    environment.HYDROPONICS_DB.prepare(`
      UPDATE device_credentials SET last_used_at = ?1 WHERE id = ?2;
    `).bind(now.toISOString(), device.credential_id).run()
  );
  context?.waitUntil?.(maintenance);

  if (!bulk) {
    const result = results[0];
    return apiResponse({
      schema_version: 1,
      device_id: device.device_id,
      ...result
    }, responseStatusFor(result));
  }

  return apiResponse({
    schema_version: 1,
    device_id: device.device_id,
    summary: { accepted, duplicate: duplicates, rejected },
    results
  });
}
