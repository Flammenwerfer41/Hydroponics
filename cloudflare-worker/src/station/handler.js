import { authenticateAdmin } from "../admin/access.js";
import { authenticateDevice } from "../ingestion/auth.js";
import { jsonResponse } from "../http/response.js";
import { HARDWARE, SHA_PATTERN, INTERVALS, normalizeStatus, validateManifest, verifyManifest } from "./contract.js";
import { readLimited, uploadFirmware, verifyStoredImage } from "./firmware.js";
import { experimentControl, experimentAction, storeExperimentResult, storeImmediateUpload } from './experiments.js';

const response = (body, status = 200) => jsonResponse(body, status, { "Cache-Control": "no-store" });
const error = (message, status = 400) => response({ error: { message } }, status);

export async function stationControl(database, deviceId, now = new Date()) {
  const row = await database.prepare(`
    SELECT c.*, r.version, r.size, r.signature, r.sha256, r.hardware AS release_hardware
    FROM station_control c LEFT JOIN station_releases r ON r.sha256 = c.target_sha256
    WHERE c.device_id = ?1
  `).bind(deviceId).first();
  if (!row) return null;
  return {
    schema_version: 1,
    server_time: now.toISOString(),
    experiment: await experimentControl(database, deviceId, now),
    discard_experiment_sequence: row.discard_experiment_sequence || 0,
    schedule: row.normal_interval_seconds ? { normal_interval_seconds: row.normal_interval_seconds, revision: row.schedule_revision } : null,
    maintenance: row.maintenance_id && Date.parse(row.maintenance_expires_at) > now.getTime()
      ? { id: row.maintenance_id, duration_seconds: 900, expires_at: row.maintenance_expires_at } : null,
    update: row.sha256 && row.release_hardware === row.hardware ? {
      hardware: row.release_hardware, version: row.version, size: row.size,
      sha256: row.sha256, signature: row.signature,
      manual_until_epoch: row.manual_ota_sha256 === row.sha256 && Date.parse(row.manual_ota_expires_at) > now.getTime()
        ? Math.floor(Date.parse(row.manual_ota_expires_at) / 1000) : 0
    } : null
  };
}

export async function recordStationStatus(database, deviceId, input) {
  const status = normalizeStatus(input);
  await database.prepare(`UPDATE station_control SET reported_at = ?1, reported_status = ?2
    WHERE device_id = ?3`).bind(new Date().toISOString(), JSON.stringify(status), deviceId).run();
  if (status.experiment?.immediate_upload) {
    // Diagnostics must never break readings acknowledgements or ordinary device control.
    try { await storeImmediateUpload(database, deviceId, status.experiment.immediate_upload); }
    catch { console.warn('Station immediate upload diagnostic could not be saved'); }
  }
}

export async function completeStationOta(database, deviceId, target, reading, now) {
  const measured = Date.parse(reading.measuredAt);
  const age = now.getTime() - measured;
  if (reading.firmwareVersion !== target.version || !Number.isFinite(age) || age > 300_000 || age < -30_000 ||
      !reading.values.some(field => field.quality === 'valid' && field.value !== null &&
        ['air_temperature', 'humidity', 'pressure', 'battery_voltage'].includes(field.metric))) return false;

  const id = crypto.randomUUID();
  const stamp = now.toISOString();
  // A qualifying observation must postdate the current approval, even for a reapproved SHA.
  // Only this transaction's inserted event can authorize clearing the target.
  const [completion] = await database.batch([
    database.prepare(`INSERT INTO station_ota_completions (id,device_id,sha256,measured_at,completed_at)
      SELECT ?1,c.device_id,c.target_sha256,?2,?3 FROM station_control c
      JOIN station_releases r ON r.sha256=c.target_sha256 AND r.hardware=c.hardware
      WHERE c.device_id=?4 AND c.target_sha256=?5 AND r.version=?6
        AND c.reported_at>=?7 AND json_extract(c.reported_status,'$.firmware_version')=r.version
        AND (SELECT e.created_at FROM station_events e
          WHERE e.device_id=c.device_id AND e.action='approve' AND e.sha256=c.target_sha256
          ORDER BY e.created_at DESC LIMIT 1)<MIN(?2,?3)`)
      .bind(id,reading.measuredAt,stamp,deviceId,target.sha256,target.version,new Date(now.getTime()-300_000).toISOString()),
    database.prepare(`UPDATE station_control SET target_sha256=NULL,manual_ota_expires_at=NULL,
      manual_ota_sha256=NULL,updated_at=?1,updated_by='station-observation'
      WHERE device_id=?2 AND target_sha256=?3 AND EXISTS (SELECT 1 FROM station_ota_completions WHERE id=?4)`)
      .bind(stamp,deviceId,target.sha256,id)
  ]);
  return Number(completion.meta?.changes) === 1;
}

async function readBody(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
    throw new Error("Expected application/json");
  return JSON.parse(new TextDecoder().decode(await readLimited(request, 8192)));
}

export async function handleStationDevice(request, env, path) {
  if (env.PUBLIC_API_RATE_LIMITER) {
    const limit = await env.PUBLIC_API_RATE_LIMITER.limit({ key: `station:${request.headers.get("CF-Connecting-IP") || "unknown"}` });
    if (!limit.success) return error("Too many requests", 429);
  }
  if (!env.HYDROPONICS_DB) return error("Database unavailable", 503);
  const device = await authenticateDevice(request, env.HYDROPONICS_DB);
  if (!device) return error("Device authentication required", 401);
  const control = await stationControl(env.HYDROPONICS_DB, device.device_id);
  if (!control) return error("Station not enrolled", 403);
  if (path === '/v1/station/experiment/results' && request.method === 'POST') {
    try { return response(await storeExperimentResult(env.HYDROPONICS_DB,device.device_id,await readBody(request))); }
    catch { return error('Experiment results rejected'); }
  }
  if (path === '/v1/station/experiment/probe' && request.method === 'POST') {
    try {
      const input=await readBody(request);
      if (!control.experiment || input.experiment_id!==control.experiment.id) return error('Experiment not assigned',403);
      return response({experiment_id:input.experiment_id});
    } catch { return error('Invalid probe'); }
  }
  if (path === "/v1/station/status" && request.method === "POST") {
    try { await recordStationStatus(env.HYDROPONICS_DB, device.device_id, await readBody(request)); }
    catch { return error("Invalid station status"); }
    return response({ station_control: control });
  }
  const hash = path.match(/^\/v1\/station\/firmware\/([a-f0-9]{64})$/)?.[1];
  if (hash && request.method === "GET") {
    if (!control.update || hash !== control.update.sha256) return error("Release not assigned", 403);
    if (!env.STATION_FIRMWARE) return error("Firmware storage not configured", 503);
    const object = await env.STATION_FIRMWARE.get(`firmware/${hash}.bin`);
    if (!object || object.size !== control.update.size) return error("Firmware unavailable", 503);
    return new Response(object.body, { headers: {
      "Content-Type": "application/octet-stream", "Content-Length": String(object.size),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"
    } });
  }
  return error("Not found", 404);
}

// Exported separately to test validation/mutations without bypassing production Access authentication.
export async function stationAdminAction(database, bucket, pem, deviceId, input, actor, now = new Date()) {
  const station = await database.prepare("SELECT * FROM station_control WHERE device_id = ?1")
    .bind(deviceId).first();
  if (!station || station.hardware !== HARDWARE) throw new Error("Station not enrolled");
  const stamp = now.toISOString();
  if (['experiment','experiment_cancel','experiment_draft','experiment_approve'].includes(input.action))
    return experimentAction(database,station,input,actor,now);
  if (input.action === 'approve' || input.action === 'maintenance') {
    const active = await experimentControl(database,deviceId,now);
    if (active) throw new Error('Cancel the queued experiment before OTA or maintenance');
  }
  if (input.action === 'schedule' || input.action === 'manual_ota') {
    let statement, details;
    if (input.action === 'schedule') {
      if (!INTERVALS.includes(input.normal_interval_seconds) || station.schedule_revision >= 2147483647)
        throw new Error('Invalid observation interval');
      statement = database.prepare(`UPDATE station_control SET normal_interval_seconds=?1,
        schedule_revision=schedule_revision+1, updated_at=?2,updated_by=?3 WHERE device_id=?4`)
        .bind(input.normal_interval_seconds, stamp, actor, deviceId);
      details = { normal_interval_seconds: input.normal_interval_seconds };
    } else {
      if (!station.target_sha256 || input.sha256 !== station.target_sha256) throw new Error('Select the approved release');
      const expires = new Date(now.getTime()+3600000).toISOString();
      statement = database.prepare(`UPDATE station_control SET manual_ota_expires_at=?1, manual_ota_sha256=?5,
        updated_at=?2,updated_by=?3 WHERE device_id=?4`).bind(expires,stamp,actor,deviceId,station.target_sha256);
      details = { sha256: station.target_sha256, expires_at: expires };
    }
    await database.batch([statement, database.prepare(`INSERT INTO station_policy_events
      (id,device_id,action,details,created_at,actor) VALUES (?1,?2,?3,?4,?5,?6)`)
      .bind(crypto.randomUUID(),deviceId,input.action,JSON.stringify(details),stamp,actor)]);
    return { requested: input.action, ...details };
  }
  const mutate = async (statement, hash = null) => database.batch([statement,
    database.prepare(`INSERT INTO station_events (id,device_id,action,sha256,created_at,actor)
      VALUES (?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), deviceId, input.action, hash, stamp, actor)
  ]);
  if (input.action === "maintenance" || input.action === "stop") {
    const id = input.action === "maintenance" ? crypto.randomUUID() : null;
    const expires = id ? new Date(now.getTime() + 3600000).toISOString() : null;
    await mutate(database.prepare(`UPDATE station_control SET maintenance_id = ?1, maintenance_expires_at = ?2,
      updated_at = ?3, updated_by = ?4 WHERE device_id = ?5`).bind(id, expires, stamp, actor, deviceId));
    return { requested: input.action, request_id: id, expires_at: expires };
  }
  if (input.action === "register") {
    const manifest = validateManifest(input.manifest);
    if (!await verifyManifest(manifest, pem)) throw new Error("Untrusted firmware signature");
    await verifyStoredImage(bucket, manifest);
    await mutate(database.prepare(`INSERT INTO station_releases
      (sha256, hardware, version, size, signature, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(sha256) DO NOTHING`).bind(manifest.sha256, manifest.hardware, manifest.version,
      manifest.size, manifest.signature, stamp, actor), manifest.sha256);
    return { registered: manifest.sha256, approved: false };
  }
  if (input.action === "approve" || input.action === "pause") {
    let hash = null;
    if (input.action === "approve") {
      if (!SHA_PATTERN.test(input.sha256)) throw new Error("Invalid release hash");
      const release = await database.prepare("SELECT * FROM station_releases WHERE sha256 = ?1")
        .bind(input.sha256).first();
      if (!release || release.hardware !== station.hardware || !await verifyManifest(release, pem))
        throw new Error("Release is not trusted for this hardware");
      await verifyStoredImage(bucket, release);
      hash = release.sha256;
    }
    await mutate(database.prepare(`UPDATE station_control SET target_sha256 = ?1, manual_ota_expires_at = NULL, manual_ota_sha256 = NULL, updated_at = ?2,
      updated_by = ?3 WHERE device_id = ?4`).bind(hash, stamp, actor, deviceId), hash);
    return { target_sha256: hash };
  }
  throw new Error("Unknown action");
}

export async function handleStationAdmin(request, env, path) {
  const admin = await authenticateAdmin(request, env);
  if (!admin) return error("Cloudflare Access authentication required", 401);
  if (!env.HYDROPONICS_DB) return error("Database unavailable", 503);
  const experimentPath=path.match(/^\/admin\/api\/stations\/([A-Za-z0-9_-]{1,64})\/experiments(?:\/([a-f0-9-]{36}))?$/);
  if (experimentPath && request.method === 'GET') {
    const [,deviceId,id]=experimentPath;
    if (id) {
      const run=await env.HYDROPONICS_DB.prepare('SELECT * FROM station_experiments WHERE device_id=?1 AND id=?2').bind(deviceId,id).first();
      if (!run) return error('Experiment not found',404);
      const chunks=await env.HYDROPONICS_DB.prepare('SELECT offset,payload FROM station_experiment_chunks WHERE experiment_id=?1 ORDER BY offset LIMIT 6').bind(id).all();
      return response({experiment:run,chunks:chunks.results.map(c=>({offset:c.offset,samples:JSON.parse(c.payload)}))});
    }
    const runs=await env.HYDROPONICS_DB.prepare(`SELECT e.*,d.title,d.purpose FROM station_experiments e
      LEFT JOIN station_experiment_drafts d ON d.approved_id=e.id WHERE e.device_id=?1 ORDER BY e.sequence DESC LIMIT 20`).bind(deviceId).all();
    const drafts=await env.HYDROPONICS_DB.prepare('SELECT * FROM station_experiment_drafts WHERE device_id=?1 ORDER BY updated_at DESC LIMIT 20').bind(deviceId).all();
    return response({experiments:runs.results,drafts:drafts.results});
  }
  if (request.method === "GET" && path === "/admin/api/stations") {
    const [stations, releases] = await Promise.all([
      env.HYDROPONICS_DB.prepare(`SELECT c.*, o.sha256 AS completed_ota_sha256,
        o.completed_at AS completed_ota_at, r.version AS completed_ota_version
        FROM station_control c LEFT JOIN station_ota_completions o ON o.id=(
          SELECT id FROM station_ota_completions WHERE device_id=c.device_id ORDER BY completed_at DESC LIMIT 1)
        LEFT JOIN station_releases r ON r.sha256=o.sha256 ORDER BY c.device_id LIMIT 50`).all(),
      env.HYDROPONICS_DB.prepare("SELECT * FROM station_releases ORDER BY created_at DESC LIMIT 20").all()
    ]);
    return response({ stations: stations.results, releases: releases.results,
      readiness: { storage: Boolean(env.STATION_FIRMWARE), signing_key: Boolean(env.STATION_OTA_PUBLIC_KEY) } });
  }
  const eventsId = path.match(/^\/admin\/api\/stations\/([A-Za-z0-9_-]{1,64})\/events$/)?.[1];
  if (eventsId && request.method === "GET") {
    const result = await env.HYDROPONICS_DB.prepare(`SELECT action,sha256,created_at,actor,NULL AS details FROM station_events
      WHERE device_id = ?1 UNION ALL SELECT action,NULL AS sha256,created_at,actor,details FROM station_policy_events
      WHERE device_id = ?1 UNION ALL SELECT action,NULL AS sha256,created_at,actor,details FROM station_experiment_events
      WHERE device_id = ?1 UNION ALL SELECT 'ota_completed' AS action,sha256,completed_at AS created_at,
      'station-observation' AS actor,NULL AS details FROM station_ota_completions WHERE device_id = ?1
      ORDER BY created_at DESC LIMIT 50`).bind(eventsId).all();
    return response({ events: result.results });
  }
  const uploadId = path.match(/^\/admin\/api\/stations\/([A-Za-z0-9_-]{1,64})\/firmware$/)?.[1];
  if (uploadId && request.method === "POST") {
    if (request.headers.get("Origin") !== new URL(request.url).origin) return error("Same-origin request required", 403);
    try {
      const station = await env.HYDROPONICS_DB.prepare("SELECT hardware FROM station_control WHERE device_id = ?1").bind(uploadId).first();
      if (station?.hardware !== HARDWARE) return error("Station not enrolled", 404);
      const manifest = await uploadFirmware(request, env.STATION_FIRMWARE, env.STATION_OTA_PUBLIC_KEY);
      return response(await stationAdminAction(env.HYDROPONICS_DB, env.STATION_FIRMWARE,
        env.STATION_OTA_PUBLIC_KEY, uploadId, { action: "register", manifest }, admin.id), 201);
    } catch { return error("Firmware rejected: check signature, binary, manifest and storage"); }
  }
  const id = path.match(/^\/admin\/api\/stations\/([A-Za-z0-9_-]{1,64})$/)?.[1];
  if (!id || request.method !== "POST") return error("Not found", 404);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return error("Same-origin request required", 403);
  try {
    return response(await stationAdminAction(env.HYDROPONICS_DB, env.STATION_FIRMWARE,
      env.STATION_OTA_PUBLIC_KEY, id, await readBody(request), admin.id));
  } catch (caught) {
    console.warn("Station management request rejected", caught.message);
    return error("Station operation rejected: check enrollment, signature, storage and request fields");
  }
}
