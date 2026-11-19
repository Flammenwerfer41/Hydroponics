import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { generateKeyPairSync, sign, createPublicKey } from "node:crypto";
import worker from "../src/index.js";
import { sha256Hex } from "../src/ingestion/auth.js";
import { stationAdminAction, stationControl } from "../src/station/handler.js";
import { HARDWARE, validateManifest, verifyManifest, normalizeStatus, normalizeSchedule, normalizeAstronomy, SOLAR_MODEL } from "../src/station/contract.js";
import { makeManifest, checkConfiguration } from "../../weather-station/scripts/release.mjs";
import { uploadFirmware, verifyImage, readLimited } from "../src/station/firmware.js";
import { estimatedBatteryPercent } from "../../docs/weather/battery.mjs";
import { validateRecipe, validateResult, normalizeExperimentStatus, storeExperimentResult } from '../src/station/experiments.js';

const TOKEN = "station-test-credential-not-production";
const ID = "balcony-weather-01";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
const image = Buffer.alloc(1024);
image[0] = 0xe9; image.writeUInt16LE(13, 12); image.writeUInt32LE(0xabcd5432, 32);
image.write("1.0.1", 48); image.write("balcony-weather", 80);
const manifest = makeManifest(image, "1.0.1", keys.privateKey);
const status = { firmware_version: "1.0.0", mode: "normal", queued: 1, dropped: 0,
  ota_attempts: 0, ota_sha256: "", ota_next_attempt: 0 };
const sqlFile = path => readFileSync(new URL(path, import.meta.url), "utf8");

// Exercise real SQLite constraints, joins and mutations without any remote D1.
class LocalD1 {
  db = new DatabaseSync(":memory:");
  queries = [];
  pendingBatch = Promise.resolve();
  prepare(sql) {
    this.queries.push(sql);
    const statement = this.db.prepare(sql);
    let params = [];
    const bindings = () => Object.fromEntries(params.map((value, i) => [String(i + 1), value]));
    const args = () => /\?\d/.test(sql) ? [bindings()] : params;
    return { bind(...values) { params = values; return this; },
      async first() { return statement.get(...args()) ?? null; },
      async all() { return { results: statement.all(...args()) }; },
      async run() { return { success: true, meta: statement.run(...args()) }; } };
  }
  async batch(statements) {
    const previous=this.pendingBatch;
    let release;
    this.pendingBatch=new Promise(resolve=>{release=resolve;});
    await previous;
    this.db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT"); return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { release(); }
  }
}
async function environment(t) {
  const database = new LocalD1();
  database.db.exec(sqlFile("../migrations/0001_initial.sql"));
  database.db.exec(`INSERT INTO sites VALUES ('home-lab','Home','Asia/Tokyo',NULL,'2026-01-01','2026-01-01');
    INSERT INTO zones (id,site_id,name,created_at,updated_at) VALUES ('tower-01','home-lab','Tower','2026-01-01','2026-01-01');
    INSERT INTO devices (id,site_id,zone_id,name,created_at,updated_at)
      VALUES ('esp32-01','home-lab','tower-01','Tower ESP','2026-01-01','2026-01-01');`);
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(name => /^\d.*\.sql$/.test(name) && !name.startsWith("0001")).sort())
    database.db.exec(readFileSync(new URL(name, dir), "utf8"));
  database.db.exec(sqlFile("../scripts/enroll-weather-station.sql"));
  database.db.exec(sqlFile("../scripts/enroll-weather-station.sql")); // idempotent enrollment
  database.db.prepare(`INSERT INTO device_credentials (id,device_id,label,secret_sha256,created_at)
    VALUES ('station-test',?,'test',?,'2026-01-01')`).run(ID, await sha256Hex(TOKEN));
  t.after(() => database.db.close());
  const objectFor = bytes => ({ size: bytes.length, body: bytes, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
  const objects = new Map([[`firmware/${manifest.sha256}.bin`, objectFor(image)]]);
  return { HYDROPONICS_DB: database, STATION_OTA_PUBLIC_KEY: keys.publicKey,
    STATION_FIRMWARE: { head: async key => objects.get(key), get: async key => objects.get(key),
      put: async (key, bytes, options) => {
        assert.equal(options.onlyIf.get("If-None-Match"), "*");
        if (objects.has(key)) return null;
        objects.set(key, objectFor(bytes)); return objects.get(key);
      } } };
}
function request(path, body, extraHeaders = {}) {
  return new Request(`https://worker.example${path}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined });
}
async function fetchLocal(req, env) {
  const pending = [];
  const result = await worker.fetch(req, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending); return result;
}
const action = (env, input, now) => stationAdminAction(env.HYDROPONICS_DB, env.STATION_FIRMWARE,
  env.STATION_OTA_PUBLIC_KEY, ID, input, "test-admin", now);

const experimentIdle={schema_version:1,available:true,sequence:0,state:'idle',id:'',outcome:'',samples:0,upload_attempts:0};
const recipe={schema_version:1,sample_interval_ms:50,steps:[
  {action:'idle',duration_ms:2000},{action:'cpu_load',duration_ms:2000},
  {action:'wifi_connect',duration_ms:8000},{action:'network_probe',duration_ms:6000},
  {action:'wifi_stop',duration_ms:100},{action:'idle',duration_ms:5000}
]};
async function createExperiment(env) {
  const result=await fetchLocal(request('/v1/station/status',{...status,firmware_version:'2.0.0',experiment:experimentIdle}),env);
  assert.equal(result.status,200);
  return (await action(env,{action:'experiment',recipe})).experiment;
}
function resultChunk(run,total=150,offset=0) {
  return {schema_version:1,id:run.id,sequence:run.sequence,firmware_version:'2.0.0',outcome:'completed',
    started_epoch:Math.floor(Date.now()/1000),sample_interval_ms:50,total_samples:total,offset,
    step_results:recipe.steps.map(()=>[0,0,false]),
    samples:Array.from({length:Math.min(100,total-offset)},(_,i)=>[(offset+i)*50000,0,2200,3600])};
}
test('experiment recipe rejects arbitrary commands, bad ordering and resource overflow',()=>{
  assert.deepEqual(validateRecipe(recipe),recipe);
  assert.throws(()=>validateRecipe({...recipe,sample_interval_ms:20}));
  assert.throws(()=>validateRecipe({...recipe,sample_interval_ms:25}));
  assert.throws(()=>validateRecipe({...recipe,url:'https://other.example'}));
  assert.throws(()=>validateRecipe({...recipe,steps:[{action:'shell',duration_ms:1000}]}));
  assert.throws(()=>validateRecipe({...recipe,steps:[{action:'network_probe',duration_ms:1000}]}));
  assert.throws(()=>validateRecipe({...recipe,steps:[{action:'wifi_connect',duration_ms:1000}]}));
  assert.throws(()=>validateRecipe({...recipe,steps:Array(5).fill({action:'idle',duration_ms:15000})}));
  assert.throws(()=>validateRecipe({...recipe,steps:[{action:'idle',duration_ms:0}]}));
  assert.throws(()=>validateRecipe({...recipe,steps:[{action:'idle',duration_ms:1000,loop:100}]}));
  assert.deepEqual(normalizeExperimentStatus(experimentIdle),experimentIdle);
  assert.throws(()=>normalizeExperimentStatus({...experimentIdle,upload_attempts:19}));
});
test('drafts never reach a device before explicit immutable-revision approval',async t=>{
  const env=await environment(t);
  const draft=(await action(env,{action:'experiment_draft',title:'Wi-Fi voltage',purpose:'recovery',recipe})).draft;
  assert.equal((await stationControl(env.HYDROPONICS_DB,ID)).experiment,null);
  const updated=(await action(env,{action:'experiment_draft',id:draft.id,revision:1,title:'Wi-Fi voltage v2',purpose:'recovery',recipe})).draft;
  assert.equal(updated.revision,2);
  await assert.rejects(action(env,{action:'experiment_draft',id:draft.id,revision:1,title:'stale',purpose:'',recipe}));
  await assert.rejects(action(env,{action:'experiment_approve',id:draft.id,revision:2})); // old firmware
  await fetchLocal(request('/v1/station/status',{...status,firmware_version:'2.0.0',experiment:experimentIdle}),env);
  await assert.rejects(action(env,{action:'experiment_approve',id:draft.id,revision:1}));
  const approved=await action(env,{action:'experiment_approve',id:draft.id,revision:2});
  assert.ok(approved.experiment.id);
  await assert.rejects(action(env,{action:'experiment_draft',id:draft.id,revision:2,title:'changed after approval',purpose:'',recipe}));
  await assert.rejects(action(env,{action:'experiment_approve',id:draft.id,revision:2}));
  assert.equal(env.HYDROPONICS_DB.db.prepare('SELECT COUNT(*) AS n FROM station_experiments').get().n,1);
});
test('experiment assignment is opt-in, one queued run, authenticated and excludes OTA/maintenance',async t=>{
  const env=await environment(t);
  await assert.rejects(action(env,{action:'experiment',recipe}));
  const run=await createExperiment(env);
  assert.equal(run.sequence,1);
  await assert.rejects(action(env,{action:'experiment',recipe}));
  await assert.rejects(action(env,{action:'maintenance'}));
  await assert.rejects(action(env,{action:'approve',sha256:manifest.sha256}));
  assert.equal((await fetchLocal(request('/v1/station/experiment/probe',{experiment_id:run.id}),env)).status,200);
  assert.equal((await fetchLocal(request('/v1/station/experiment/probe',{experiment_id:crypto.randomUUID()}),env)).status,403);
  assert.equal((await fetchLocal(request('/v1/station/experiment/probe',{experiment_id:run.id},{Authorization:''}),env)).status,401);
  assert.equal((await fetchLocal(request(`/admin/api/stations/${ID}/experiments`),env)).status,401);
  assert.equal((await stationControl(env.HYDROPONICS_DB,ID,new Date(Date.now()+7*3600000))).experiment,null);
});
test('experiment chunks are separately stored, idempotent and complete only after every chunk',async t=>{
  const env=await environment(t),run=await createExperiment(env),first=resultChunk(run);
  const post=body=>fetchLocal(request('/v1/station/experiment/results',body),env);
  assert.deepEqual(await (await post(first)).json(),{id:run.id,next_offset:100,complete:false});
  assert.equal((await post(first)).status,200);
  const changed=structuredClone(first); changed.samples[0][3]=3700;
  assert.equal((await post(changed)).status,400);
  const last={...first,offset:100,samples:resultChunk(run,150,100).samples};
  assert.equal((await post(last)).status,200);
  assert.equal((await post(first)).status,200);
  assert.equal(env.HYDROPONICS_DB.db.prepare('SELECT status FROM station_experiments').get().status,'completed');
  assert.equal(env.HYDROPONICS_DB.db.prepare('SELECT COUNT(*) AS n FROM station_experiment_chunks').get().n,2);
  assert.equal(env.HYDROPONICS_DB.db.prepare('SELECT COUNT(*) AS n FROM readings').get().n,0);
  assert.equal(env.HYDROPONICS_DB.db.prepare('SELECT COUNT(*) AS n FROM station_night_closings').get().n,0);
  assert.equal((await post({...last,firmware_version:'2.0.1'})).status,400);
  env.HYDROPONICS_DB.db.prepare('DELETE FROM station_experiment_chunks WHERE experiment_id=? AND offset=0').run(run.id);
  assert.deepEqual(await (await post(last)).json(),{id:run.id,next_offset:0,complete:false});
  assert.deepEqual(await (await post(first)).json(),{id:run.id,next_offset:150,complete:true});
});
test('experiment results reject malformed, foreign, oversized and conflicting concurrent chunks',async t=>{
  const env=await environment(t),run=await createExperiment(env),chunk=resultChunk(run,1);
  const row=env.HYDROPONICS_DB.db.prepare('SELECT * FROM station_experiments').get();
  assert.throws(()=>validateResult({...chunk,total_samples:601},row));
  assert.throws(()=>validateResult({...chunk,offset:1},row));
  assert.throws(()=>validateResult({...chunk,samples:[[0,99,2000,3600]]},row));
  assert.throws(()=>validateResult({...chunk,samples:[[0,0,2000,NaN]]},row));
  assert.throws(()=>validateResult({...chunk,samples:[[0,0,4096,3600]]},row));
  await assert.rejects(storeExperimentResult(env.HYDROPONICS_DB,'esp32-01',chunk));
  const post=body=>fetchLocal(request('/v1/station/experiment/results',body),env);
  assert.equal((await post({...chunk,padding:'x'.repeat(9000)})).status,400);
  const outcomes=await Promise.all([post(chunk),post({...chunk,outcome:'interrupted'})]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,400]);
});
test('interrupted zero-sample results are accepted and cancellation never reassigns a sequence',async t=>{
  const env=await environment(t),run=await createExperiment(env);
  const empty={...resultChunk(run,0),outcome:'interrupted'};
  assert.equal((await fetchLocal(request('/v1/station/experiment/results',empty),env)).status,200);
  const second=await createExperiment(env);
  assert.ok(second.sequence>run.sequence);
  await action(env,{action:'experiment_cancel',sequence:second.sequence});
  const control=await stationControl(env.HYDROPONICS_DB,ID);
  assert.equal(control.experiment,null); assert.equal(control.discard_experiment_sequence,second.sequence);
  assert.equal((await fetchLocal(request('/v1/station/experiment/results',resultChunk(second)),env)).status,400);
  const third=await createExperiment(env); assert.ok(third.sequence>second.sequence);
});

const schedule = { normal_interval_seconds: 300, applied_interval_seconds: 3600, revision: 2, reason: 'emergency_voltage' };
test('night closing keeps the first local-date observation, including delayed replay and null voltage', async t => {
  const env=await environment(t);
  const localDay=Math.floor((Date.now()+9*3600000)/86400000)*86400000-9*3600000-86400000;
  const iso=hours=>new Date(localDay+hours*3600000).toISOString();
  const astronomy={model:SOLAR_MODEL,solar_altitude_deg:-22,night:true,night_closing:true,
    astronomical_dawn:iso(5),astronomical_dusk:iso(18)};
  const observation=(seq,hours,battery)=>({schema_version:1,reading_id:`nighttestboot:${seq}`,boot_id:'nighttestboot',sequence:seq,
    measured_at:iso(hours),firmware_version:'1.2.0',values:{battery_voltage:battery,air_temperature:15},station_schedule:schedule,astronomy});
  assert.equal((await fetchLocal(request('/v1/readings',observation(2,18.5,3.6)),env)).status,201);
  assert.equal((await fetchLocal(request('/v1/readings',observation(1,18.25,null)),env)).status,201);
  assert.equal((await fetchLocal(request('/v1/readings',observation(2,18.5,3.6)),env)).status,200);
  const result=await (await fetchLocal(request(`/v1/readings/latest?device_id=${ID}&days=7&metrics=battery_voltage,air_temperature`),env)).json();
  assert.equal(result.night_closing.measured_at,iso(18.25));
  assert.equal(result.night_closing.values.battery_voltage,null);
  assert.equal(result.night_closing.astronomy.night_closing,true);
  assert.equal(result.night_closing.device_id,undefined);
  assert.equal(env.HYDROPONICS_DB.db.prepare('SELECT count(*) AS n FROM station_night_closings').get().n,1);
  assert.equal((await fetchLocal(request('/v1/readings',observation(3,20,3.6)),env)).status,422);
  for (const changes of [{night:false},{model:'other'},{solar_altitude_deg:NaN},{astronomical_dusk:iso(18+24)}])
    assert.throws(()=>normalizeAstronomy({...astronomy,...changes},Date.parse(iso(18.5)),schedule));
});
test('schedule accepts only bounded periods and distinguishes emergency from normal', () => {
  assert.deepEqual(normalizeSchedule(schedule), schedule);
  for (const change of [{normal_interval_seconds:60}, {applied_interval_seconds:300}, {revision:-1},
    {revision:1.2}, {reason:'adaptive'}, {normal_interval_seconds:'300'}])
    assert.throws(() => normalizeSchedule({...schedule,...change}));
  const powerStatus = {...status,mode:'emergency',schedule,power_mode:'emergency',battery_voltage:3.2,
    automatic_ota_min_voltage:3.6,manual_ota_min_voltage:3.5};
  assert.deepEqual(normalizeStatus(powerStatus), powerStatus);
  assert.throws(() => normalizeStatus({...powerStatus,battery_voltage:NaN}));
});
test('manual interval revisions are durable and audit mutations are atomic', async t => {
  const env = await environment(t);
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID)).schedule, null);
  await action(env,{action:'schedule',normal_interval_seconds:600});
  assert.deepEqual((await stationControl(env.HYDROPONICS_DB,ID)).schedule,{normal_interval_seconds:600,revision:1});
  await assert.rejects(action(env,{action:'schedule',normal_interval_seconds:60}));
  await action(env,{action:'schedule',normal_interval_seconds:3600});
  assert.equal((await stationControl(env.HYDROPONICS_DB,ID)).schedule.revision,2);
  env.HYDROPONICS_DB.db.exec("CREATE TRIGGER fail_policy BEFORE INSERT ON station_policy_events BEGIN SELECT RAISE(ABORT,'test'); END;");
  await assert.rejects(action(env,{action:'schedule',normal_interval_seconds:300}));
  assert.equal((await stationControl(env.HYDROPONICS_DB,ID)).schedule.normal_interval_seconds,3600);
});
test('manual OTA is scoped to the approved hash, expires, and approval clears the exception', async t => {
  const env = await environment(t), now = new Date();
  await assert.rejects(action(env,{action:'manual_ota',sha256:manifest.sha256},now));
  await action(env,{action:'register',manifest}); await action(env,{action:'approve',sha256:manifest.sha256});
  await assert.rejects(action(env,{action:'manual_ota',sha256:'f'.repeat(64)},now));
  await action(env,{action:'manual_ota',sha256:manifest.sha256},now);
  assert.ok((await stationControl(env.HYDROPONICS_DB,ID,now)).update.manual_until_epoch > now.getTime()/1000);
  assert.equal((await stationControl(env.HYDROPONICS_DB,ID,new Date(now.getTime()+3600001))).update.manual_until_epoch,0);
  await action(env,{action:'approve',sha256:manifest.sha256});
  assert.equal((await stationControl(env.HYDROPONICS_DB,ID,now)).update.manual_until_epoch,0);
});
test('observation-time schedule survives storage, replay, public history and conflict detection', async t => {
  const env = await environment(t);
  const reading = {schema_version:1,reading_id:'scheduleboot:1',boot_id:'scheduleboot',sequence:1,
    measured_at:new Date(Date.now()-3600000).toISOString(),firmware_version:'1.1.0',
    values:{battery_voltage:3.2},station_schedule:schedule};
  assert.equal((await fetchLocal(request('/v1/readings',reading),env)).status,201);
  assert.equal((await fetchLocal(request('/v1/readings',reading),env)).status,200);
  assert.equal((await fetchLocal(request('/v1/readings',{...reading,station_schedule:{...schedule,revision:3}}),env)).status,409);
  const latest=await (await fetchLocal(request(`/v1/readings/latest?device_id=${ID}&days=7&metrics=battery_voltage`),env)).json();
  assert.deepEqual(latest.reading.station_schedule,schedule);
  assert.equal((await fetchLocal(request('/v1/readings',{...reading,station_schedule:{...schedule,reason:'bad'}}),env)).status,422);
});

test("signed C6 manifests reject tampering, wrong keys, wrong board and mismatched image version", async () => {
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.equal(await verifyManifest(manifest, keys.publicKey), true);
  for (const changes of [{ size: 1025 }, { version: "1.0.2" }, { sha256: "a".repeat(64) },
    { hardware: "esp32-tower" }, { size: 2000000 }, { signature: "bad" }])
    assert.equal(await verifyManifest({ ...manifest, ...changes }, keys.publicKey), false);
  assert.equal(await verifyManifest(manifest, ""), false);
  assert.throws(() => makeManifest(image, "1.0.2", keys.privateKey));
  const wrong = Buffer.from(image); wrong.writeUInt16LE(0, 12);
  assert.throws(() => makeManifest(wrong, "1.0.1", keys.privateKey));
  const fixture = Buffer.from(image); fixture.write("compile-check-not-a-real-token-0000", 300);
  assert.throws(() => makeManifest(fixture, "1.0.1", keys.privateKey), /not deployable/);
  const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
  assert.equal(await verifyManifest(manifest, wrongKeys.publicKey), false);
  assert.throws(() => validateManifest({ ...manifest, version: "1.01.0" }));
});

test("station migration/enrollment is additive, repeatable, initially disabled", async t => {
  const env = await environment(t), db = env.HYDROPONICS_DB.db;
  assert.equal(db.prepare("SELECT count(*) AS n FROM sensors WHERE device_id=?").get(ID).n, 4);
  assert.equal(db.prepare("SELECT zone_id FROM devices WHERE id='esp32-01'").get().zone_id, "tower-01");
  const control = await stationControl(env.HYDROPONICS_DB, ID);
  assert.equal(control.update, null); assert.equal(control.maintenance, null);
  assert.equal(await stationControl(env.HYDROPONICS_DB, "esp32-01"), null);
});

test("registration does not approve; approval and pause scope firmware access to assigned image", async t => {
  const env = await environment(t);
  assert.equal((await action(env, { action: "register", manifest })).approved, false);
  const url = `/v1/station/firmware/${manifest.sha256}`;
  assert.equal((await fetchLocal(request(url), env)).status, 403);
  await action(env, { action: "approve", sha256: manifest.sha256 });
  const response = await fetchLocal(request(url), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Length"), String(image.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  assert.equal((await fetchLocal(request(`/v1/station/firmware/${"0".repeat(64)}`), env)).status, 403);
  await action(env, { action: "pause" });
  assert.equal((await fetchLocal(request(url), env)).status, 403);
  await assert.rejects(action({ ...env, STATION_FIRMWARE: undefined }, { action: "register", manifest }));
  await assert.rejects(action(env, { action: "register", manifest: { ...manifest, size: 900 } }));
});

test("revoked/absent device tokens and unauthenticated admin cannot access control or firmware", async t => {
  const env = await environment(t);
  const paths = ["/v1/station/status", `/v1/station/firmware/${manifest.sha256}`, "/admin/api/stations"];
  for (const path of paths) assert.equal((await fetchLocal(new Request(`https://worker.example${path}`), env)).status, 401);
  env.HYDROPONICS_DB.db.exec("UPDATE device_credentials SET revoked_at='2026-01-02'");
  assert.equal((await fetchLocal(request("/v1/station/status", status), env)).status, 401);
});

test("maintenance expires and renews with a new id; stop clears request; status records bounded retry state", async t => {
  const env = await environment(t), now = new Date("2026-10-12T00:00:00Z");
  const first = await action(env, { action: "maintenance" }, now);
  const control = await stationControl(env.HYDROPONICS_DB, ID, now);
  assert.equal(control.maintenance.duration_seconds, 900);
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID, new Date(now.getTime() + 3600000))).maintenance, null);
  assert.notEqual((await action(env, { action: "maintenance" }, now)).request_id, first.request_id);
  await action(env, { action: "stop" }, now);
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID, now)).maintenance, null);
  assert.equal((await fetchLocal(request("/v1/station/status", status), env)).status, 200);
  assert.deepEqual(JSON.parse(env.HYDROPONICS_DB.db.prepare("SELECT reported_status FROM station_control").get().reported_status), status);
  for (const changes of [{ queued: 1345 }, { ota_attempts: 4 }, { dropped: -1 }, { mode: "forever" }])
    assert.throws(() => normalizeStatus({ ...status, ...changes }));
  assert.equal((await fetchLocal(request("/v1/station/status", { ...status, ota_attempts: 4 }), env)).status, 400);
});

test("four metrics survive partial failures and retransmission; station response is opt-in; latest stays device-scoped", async t => {
  const env = await environment(t);
  const payload = { schema_version: 1, reading_id: "stationboot:0", boot_id: "stationboot", sequence: 0,
    measured_at: new Date(Date.now() - 1000).toISOString(), firmware_version: "1.0.0",
    values: { air_temperature: 20, humidity: null, pressure: 1002, battery_voltage: 3.97 }, station_status: status };
  const plain = await fetchLocal(request("/v1/readings", payload), env);
  assert.equal(plain.status, 201); assert.equal((await plain.json()).station_control, undefined);
  assert.equal(env.HYDROPONICS_DB.queries.some(sql => sql.includes("FROM station_control")), false);
  const duplicate = await fetchLocal(request("/v1/readings", payload, { "X-Station-Protocol": "1" }), env);
  const body = await duplicate.json();
  assert.equal(body.status, "duplicate"); assert.equal(body.reading_id, payload.reading_id);
  assert.equal(body.station_control.schema_version, 1);
  assert.equal(env.HYDROPONICS_DB.db.prepare("SELECT count(*) AS n FROM readings").get().n, 1);
  const latest = await fetchLocal(request(`/v1/readings/latest?device_id=${ID}&days=7&metrics=air_temperature,humidity,pressure,battery_voltage`), env);
  assert.equal(latest.status, 200);
  const reading = (await latest.json()).reading;
  assert.equal(reading.values.battery_voltage, 3.97); assert.equal(reading.quality.humidity, "missing");
  assert.equal(reading.values.humidity, null);
  const tower = await fetchLocal(request("/v1/readings/latest?device_id=esp32-01"), env);
  assert.equal((await tower.json()).reading, null);
});

test("admin requires verified Access plus same-origin mutation", async t => {
  const env = await environment(t);
  env.CF_ACCESS_TEAM_DOMAIN = "test.cloudflareaccess.com"; env.CF_ACCESS_AUD = "test-audience";
  const jwk = createPublicKey(keys.publicKey).export({ format: "jwk" }); jwk.kid = "test-key";
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ keys: [jwk] });
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({
    iss: "https://test.cloudflareaccess.com", aud: "test-audience", exp: Math.floor(Date.now() / 1000) + 300, sub: "owner" })}`;
  const jwt = `${unsigned}.${sign("sha256", Buffer.from(unsigned), keys.privateKey).toString("base64url")}`;
  const headers = { "Cf-Access-Jwt-Assertion": jwt };
  assert.equal((await fetchLocal(request("/admin/api/stations", null, headers), env)).status, 200);
  assert.equal((await fetchLocal(request(`/admin/api/stations/${ID}`, { action: "maintenance" }, headers), env)).status, 403);
  assert.equal((await fetchLocal(request(`/admin/api/stations/${ID}`, { action: "maintenance" },
    { ...headers, Origin: "https://worker.example" }), env)).status, 200);
  const uploadRequest = origin => new Request(`https://worker.example/admin/api/stations/${ID}/firmware`, {
    method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/octet-stream",
      "X-Station-Manifest": JSON.stringify(manifest) }, body: image
  });
  assert.equal((await fetchLocal(uploadRequest("https://evil.example"), env)).status, 403);
  assert.equal((await fetchLocal(uploadRequest("https://worker.example"), env)).status, 201);
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID)).update, null);
  const events = await fetchLocal(request(`/admin/api/stations/${ID}/events`, null, headers), env);
  assert.equal(events.status, 200); assert.equal((await events.json()).events.length, 2);
});

test("release preflight refuses empty commissioning configuration and mismatched trust keys", () => {
  const source = `#define STATION_WIFI_SSID "test"\n#define STATION_SERVER "https://worker.example"\n#define STATION_DEVICE_TOKEN "${TOKEN}"\n#define STATION_OTA_PUBLIC_KEY ${JSON.stringify(keys.publicKey)}\n`;
  assert.equal(checkConfiguration(source, keys.privateKey), true);
  assert.throws(() => checkConfiguration(source.replace(TOKEN, ""), keys.privateKey));
  assert.throws(() => checkConfiguration(source.replace(JSON.stringify(keys.publicKey), '""'), keys.privateKey));
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => checkConfiguration(source, other), /trust key/);
});

test("battery percentage is a bounded display-only estimate, null for unavailable input", () => {
  assert.equal(estimatedBatteryPercent(null), null);
  assert.equal(estimatedBatteryPercent(NaN), null);
  assert.equal(estimatedBatteryPercent(5), null);
  assert.equal(estimatedBatteryPercent(2.65), 0);
  assert.equal(estimatedBatteryPercent(3.3), 14);
  assert.equal(estimatedBatteryPercent(3.48), 31);
  assert.equal(estimatedBatteryPercent(3.6), 45);
  assert.equal(estimatedBatteryPercent(4.2), 100);
  assert.equal(estimatedBatteryPercent(3.8), 67);
  let previous = 0;
  for (let mv = 2650; mv <= 4200; mv++) {
    const percent = estimatedBatteryPercent(mv / 1000);
    assert.ok(percent >= previous && percent <= 100);
    previous = percent;
  }
});

test("binary upload is authenticated separately, signed, bounded, checksum verified and create-only", async t => {
  const env = await environment(t);
  const upload = (bytes = image, data = manifest) => new Request("https://worker.example/admin/api/stations/balcony-weather-01/firmware", {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Station-Manifest": JSON.stringify(data) }, body: bytes
  });
  assert.equal((await fetchLocal(upload(), env)).status, 401);
  assert.deepEqual(await uploadFirmware(upload(), env.STATION_FIRMWARE, keys.publicKey), manifest);
  assert.deepEqual(await uploadFirmware(upload(), env.STATION_FIRMWARE, keys.publicKey), manifest);
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID)).update, null);
  const corrupt = Buffer.from(image); corrupt[500] ^= 1;
  await assert.rejects(uploadFirmware(upload(corrupt), env.STATION_FIRMWARE, keys.publicKey), /checksum/);
  await assert.rejects(uploadFirmware(upload(image, { ...manifest, version: "1.0.2" }), env.STATION_FIRMWARE, keys.publicKey), /signature/);
  await assert.rejects(uploadFirmware(upload(Buffer.concat([image, image])), env.STATION_FIRMWARE, keys.publicKey), /large/);
  await assert.rejects(verifyImage(image, { ...manifest, version: "9.0.0" }), /version/);
  await assert.rejects(readLimited(new Request("https://example.test", { method: "POST", body: "12345" }), 4), /large/);
});

test("approval rechecks stored bytes and management events are atomic with control changes", async t => {
  const env = await environment(t);
  await action(env, { action: "register", manifest });
  await action(env, { action: "approve", sha256: manifest.sha256 });
  await action(env, { action: "pause" });
  assert.equal(env.HYDROPONICS_DB.db.prepare("SELECT count(*) AS n FROM station_events").get().n, 3);
  const bad = Buffer.from(image); bad[500] ^= 1;
  const bucket = { get: async () => ({ size: image.length, arrayBuffer: async () => Uint8Array.from(bad).buffer }) };
  await assert.rejects(action({ ...env, STATION_FIRMWARE: bucket }, { action: "approve", sha256: manifest.sha256 }), /checksum/);
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID)).update, null);
  env.HYDROPONICS_DB.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON station_events BEGIN SELECT RAISE(ABORT,'test'); END;");
  await assert.rejects(action(env, { action: "maintenance" }));
  assert.equal((await stationControl(env.HYDROPONICS_DB, ID)).maintenance, null);
});
