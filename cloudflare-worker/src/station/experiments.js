const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIONS = ['idle','cpu_load','wifi_connect','network_probe','wifi_stop','bme_measure'];
const OUTCOMES = ['completed','interrupted','expired','clock_unavailable','battery_not_ready',
  'backlog_pending','sampler_failed','low_voltage','adc_unavailable','sample_limit','network_failed','sensor_failed'];
const RELEASE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const IMMEDIATE_UPLOAD_REASONS = ['interrupted','experiment_not_completed','clock_unavailable','emergency',
  'battery_unavailable','battery_low','window_too_short','wifi_failed','wifi_start_failed','wifi_connect_failed',
  'wifi_ip_timeout','deadline','http_failed','storage_error','attempt_limit','completed'];
const IMMEDIATE_UPLOAD_FIELDS = ['schema_version','id','sequence','reason','battery_mv','wifi_ms','elapsed_ms',
  'http_attempts','confirmed_samples'];
const integer = (x,min,max) => Number.isInteger(x) && x>=min && x<=max;
const keys = (obj,allowed) => obj && typeof obj==='object' && !Array.isArray(obj) &&
  Object.keys(obj).every(k=>allowed.includes(k));
const nullableInteger = (x,min,max) => x===null || integer(x,min,max);
const supportsBmeMeasure = version => {
  const parts=RELEASE_VERSION.exec(version || '');
  if (!parts) return false;
  const [major,minor,patch]=parts.slice(1).map(Number);
  return major>2 || (major===2 && (minor>0 || patch>=4));
};

export function validateRecipe(input) {
  if (!keys(input,['schema_version','sample_interval_ms','steps']) || input.schema_version!==1 ||
      !integer(input.sample_interval_ms,20,1000) || input.sample_interval_ms%10 ||
      !Array.isArray(input.steps) || input.steps.length<1 || input.steps.length>8) throw Error('Invalid experiment recipe');
  let total=0, radio=false, connects=0, probes=0, sensorSteps=0;
  const steps=input.steps.map(s=>{
    if (!keys(s,['action','duration_ms']) || !ACTIONS.includes(s.action) || !integer(s.duration_ms,100,15000))
      throw Error('Invalid experiment step');
    total+=s.duration_ms;
    if (s.action==='wifi_connect') {
      if (radio || ++connects>1 || s.duration_ms<1000) throw Error('Only one bounded connection is allowed');
      radio=true;
    }
    if (s.action==='network_probe' && (!radio || ++probes>1 || s.duration_ms<1000)) throw Error('Invalid network probe');
    if (s.action==='wifi_stop') { if (!radio) throw Error('Radio already stopped'); radio=false; }
    if (s.action==='bme_measure' && (radio || ++sensorSteps>1 || s.duration_ms<1000))
      throw Error('One BME280 measurement step of at least one second requires Wi-Fi off');
    return {action:s.action,duration_ms:s.duration_ms};
  });
  if (radio || total>60000 || Math.ceil(total/input.sample_interval_ms)+steps.length+2>600)
    throw Error('Experiment exceeds time/sample limits or leaves radio on');
  return {schema_version:1,sample_interval_ms:input.sample_interval_ms,steps};
}
export function normalizeExperimentStatus(input) {
  if (!input || input.schema_version!==1 || typeof input.available!=='boolean' ||
      !integer(input.sequence,0,2147483647) || !['idle','queued','running','result_pending','storage_error'].includes(input.state) ||
      !(input.id==='' || UUID.test(input.id)) || !(input.outcome==='' || OUTCOMES.includes(input.outcome)) ||
      !integer(input.samples,0,600) || !integer(input.upload_attempts,0,18)) throw Error('Invalid experiment status');
  const status=Object.fromEntries(['schema_version','available','sequence','state','id','outcome','samples','upload_attempts'].map(k=>[k,input[k]]));
  const diagnostic=input.immediate_upload;
  // Keep ordinary status and telemetry valid even if the optional sidecar is malformed.
  if (keys(diagnostic,IMMEDIATE_UPLOAD_FIELDS) && diagnostic.schema_version===1 &&
      typeof diagnostic.id==='string' && UUID.test(diagnostic.id) && integer(diagnostic.sequence,1,input.sequence) &&
      IMMEDIATE_UPLOAD_REASONS.includes(diagnostic.reason) && nullableInteger(diagnostic.battery_mv,2000,4500) &&
      nullableInteger(diagnostic.wifi_ms,0,30000) && nullableInteger(diagnostic.elapsed_ms,0,31000) &&
      integer(diagnostic.http_attempts,0,6) && integer(diagnostic.confirmed_samples,0,600)) {
    status.immediate_upload=Object.fromEntries(IMMEDIATE_UPLOAD_FIELDS.map(k=>[k,diagnostic[k]]));
  }
  return status;
}
export async function storeImmediateUpload(db,deviceId,diagnostic) {
  // A later status may still carry the previous run. Bind all three identifiers; never
  // change the run's result metadata. A delayed interrupted marker cannot erase the final report.
  await db.prepare(`UPDATE station_experiments SET immediate_upload=?1
    WHERE device_id=?2 AND id=?3 AND sequence=?4 AND status!='cancelled'
      AND immediate_upload IS NOT ?1
      AND (immediate_upload IS NULL OR json_extract(immediate_upload,'$.reason')='interrupted')`)
    .bind(JSON.stringify(diagnostic),deviceId,diagnostic.id,diagnostic.sequence).run();
}
export async function experimentControl(db,deviceId,now) {
  const row=await db.prepare(`SELECT * FROM station_experiments WHERE device_id=?1 AND status='queued'
    AND expires_at>?2 ORDER BY sequence DESC LIMIT 1`).bind(deviceId,now.toISOString()).first();
  return row ? {...JSON.parse(row.recipe), id:row.id,sequence:row.sequence,expires_epoch:Math.floor(Date.parse(row.expires_at)/1000)} : null;
}
export async function experimentAction(db,station,input,actor,now) {
  const stamp=now.toISOString(), deviceId=station.device_id;
  if (input.action==='experiment_draft') {
    const recipe=validateRecipe(input.recipe);
    if (typeof input.title!=='string' || !input.title.trim() || input.title.length>80 ||
        typeof input.purpose!=='string' || input.purpose.length>1000) throw Error('실험 제목(80자)과 목적(1000자)을 확인하세요.');
    const id=input.id || crypto.randomUUID();
    if (!UUID.test(id)) throw Error('Invalid draft id');
    if (input.id) {
      if (!integer(input.revision,1,2147483646)) throw Error('Invalid revision');
      const update=await db.prepare(`UPDATE station_experiment_drafts SET title=?1,purpose=?2,recipe=?3,revision=revision+1,
        updated_at=?4,updated_by=?5 WHERE id=?6 AND device_id=?7 AND revision=?8 AND approved_id IS NULL`)
        .bind(input.title.trim(),input.purpose,JSON.stringify(recipe),stamp,actor,id,deviceId,input.revision).run();
      if (Number(update.meta?.changes)!==1) throw Error('초안이 변경되었거나 이미 승인되었습니다.');
    } else await db.prepare(`INSERT INTO station_experiment_drafts
      (id,device_id,title,purpose,recipe,created_at,updated_at,updated_by) VALUES (?1,?2,?3,?4,?5,?6,?6,?7)`)
      .bind(id,deviceId,input.title.trim(),input.purpose,JSON.stringify(recipe),stamp,actor).run();
    const draft=await db.prepare('SELECT * FROM station_experiment_drafts WHERE id=?1 AND device_id=?2').bind(id,deviceId).first();
    if (!draft || draft.approved_id || draft.revision!==(input.id?input.revision+1:1) || draft.updated_at!==stamp || draft.recipe!==JSON.stringify(recipe))
      throw Error('초안이 변경되었거나 이미 승인되었습니다. 새로고침하세요.');
    return {draft};
  }
  let draft=null;
  if (input.action==='experiment_approve') {
    if (!UUID.test(input.id || '') || !integer(input.revision,1,2147483647)) throw Error('Invalid draft approval');
    draft=await db.prepare('SELECT * FROM station_experiment_drafts WHERE id=?1 AND device_id=?2').bind(input.id,deviceId).first();
    if (!draft || draft.approved_id || draft.revision!==input.revision) throw Error('초안이 변경되었거나 이미 승인되었습니다.');
    input={...input,recipe:JSON.parse(draft.recipe)};
  }
  if (input.action==='experiment_cancel') {
    if (!integer(input.sequence,1,2147483647)) throw Error('Specify experiment sequence');
    const row=await db.prepare('SELECT * FROM station_experiments WHERE device_id=?1 AND sequence=?2').bind(deviceId,input.sequence).first();
    if (!row) throw Error('Unknown experiment');
    await db.batch([
      db.prepare(`UPDATE station_experiments SET status='cancelled' WHERE device_id=?1 AND sequence=?2 AND status!='completed'`).bind(deviceId,row.sequence),
      db.prepare('UPDATE station_control SET discard_experiment_sequence=?1 WHERE device_id=?2').bind(row.sequence,deviceId),
      db.prepare(`INSERT INTO station_experiment_events (id,device_id,action,details,created_at,actor) VALUES (?1,?2,?3,?4,?5,?6)`)
        .bind(crypto.randomUUID(),deviceId,input.action,JSON.stringify({sequence:row.sequence}),stamp,actor)
    ]);
    return {cancelled:row.id,sequence:row.sequence,note:'Takes effect on next device contact; cannot interrupt an offline run'};
  }
  const recipe=validateRecipe(input.recipe);
  const receiving=await db.prepare(`SELECT id FROM station_experiments WHERE device_id=?1 AND status='receiving' LIMIT 1`).bind(deviceId).first();
  if (receiving) throw Error('Finish or explicitly cancel pending result upload first');
  const reported=JSON.parse(station.reported_status || '{}');
  if (recipe.steps.some(step=>step.action==='bme_measure') && !supportsBmeMeasure(reported.firmware_version))
    throw Error('BME280 experiments require reported firmware 2.0.4 or newer');
  if (!/^([2-9]|[1-9]\d+)\./.test(reported.firmware_version || '') || !reported.experiment?.available ||
      reported.experiment.state!=='idle' || reported.mode==='emergency' ||
      !Number.isFinite(Date.parse(station.reported_at)) || now-Date.parse(station.reported_at)>2*3600000 ||
      station.target_sha256 || Date.parse(station.maintenance_expires_at)>now.getTime())
    throw Error('Need a recent idle 2.x station, no approved OTA or maintenance');
  const id=crypto.randomUUID(), expires=new Date(now.getTime()+6*3600000).toISOString();
  await db.batch([
    db.prepare(`UPDATE station_experiments SET status='expired' WHERE device_id=?1 AND status='queued' AND expires_at<=?2`).bind(deviceId,stamp),
    draft ? db.prepare(`INSERT INTO station_experiments (id,device_id,recipe,status,created_at,expires_at,created_by)
      SELECT ?1,device_id,recipe,'queued',?2,?3,?4 FROM station_experiment_drafts
      WHERE id=?5 AND revision=?6 AND approved_id IS NULL`).bind(id,stamp,expires,actor,draft.id,draft.revision)
    : db.prepare(`INSERT INTO station_experiments (id,device_id,recipe,status,created_at,expires_at,created_by)
      VALUES (?1,?2,?3,'queued',?4,?5,?6)`).bind(id,deviceId,JSON.stringify(recipe),stamp,expires,actor),
    ...(draft ? [db.prepare(`UPDATE station_experiment_drafts SET approved_id=?1,updated_at=?2,updated_by=?3
      WHERE id=?4 AND revision=?5 AND approved_id IS NULL AND EXISTS(SELECT 1 FROM station_experiments WHERE id=?1)`)
      .bind(id,stamp,actor,draft.id,draft.revision)] : []),
    db.prepare(`INSERT INTO station_experiment_events (id,device_id,action,details,created_at,actor)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM station_experiments WHERE id=?7)`)
      .bind(crypto.randomUUID(),deviceId,'experiment',JSON.stringify({id,recipe,draft_id:draft?.id || null}),stamp,actor,id)
  ]);
  if (draft) {
    const stored=await db.prepare('SELECT approved_id FROM station_experiment_drafts WHERE id=?1').bind(draft.id).first();
    if (stored?.approved_id!==id) throw Error('초안이 변경되었습니다. 승인되지 않았습니다.');
  }
  return {experiment:await experimentControl(db,deviceId,now)};
}
export function validateResult(input,experiment) {
  const recipe=JSON.parse(experiment.recipe);
  if (!input || input.schema_version!==1 || input.id!==experiment.id || input.sequence!==experiment.sequence ||
      !RELEASE_VERSION.test(input.firmware_version) ||
      !OUTCOMES.includes(input.outcome) || !integer(input.started_epoch,0,2147483647) ||
      input.sample_interval_ms!==recipe.sample_interval_ms || !integer(input.total_samples,0,600) ||
      !integer(input.offset,0,599) || input.offset%100 || input.offset>input.total_samples ||
      (input.total_samples>0 && input.offset===input.total_samples) ||
      !Array.isArray(input.samples) || input.samples.length!==Math.min(100,input.total_samples-input.offset) ||
      !Array.isArray(input.step_results) || input.step_results.length!==recipe.steps.length)
    throw Error('Invalid experiment results');
  let previous=-1;
  for (const s of input.samples) {
    if (!Array.isArray(s) || !integer(s[0],0,70000000) || s[0]<=previous ||
        !integer(s[1],0,recipe.steps.length-1) || !(s[2]===null || integer(s[2],0,4095)) ||
        !(s[3]===null || integer(s[3],2000,4500))) throw Error('Invalid ADC sample');
    // Only samples taken within the sensor step carry its subphase. Keep older
    // sample rows and the underlying JSON/chunk storage format unchanged.
    const bmeSample=recipe.steps[s[1]].action==='bme_measure';
    if (bmeSample ? s.length!==5 || !integer(s[4],0,2) : s.length!==4) throw Error('Invalid ADC sample phase');
    previous=s[0];
  }
  for (const s of input.step_results) {
    if (!Array.isArray(s) || s.length!==3 || !integer(s[0],0,70000000) || !integer(s[1],s[0],70000000) ||
        typeof s[2]!=='boolean') throw Error('Invalid step timing');
  }
  const meta=Object.fromEntries(['schema_version','id','sequence','firmware_version','outcome','started_epoch',
    'sample_interval_ms','total_samples','step_results'].map(k=>[k,input[k]]));
  return {meta, samples:input.samples, offset:input.offset};
}
export async function storeExperimentResult(db,deviceId,input,now=new Date()) {
  const row=await db.prepare('SELECT * FROM station_experiments WHERE device_id=?1 AND id=?2').bind(deviceId,input?.id || '').first();
  if (!row || row.status==='cancelled') throw Error('Experiment not assigned');
  const result=validateResult(input,row), meta=JSON.stringify(result.meta), payload=JSON.stringify(result.samples);
  const existing=await db.prepare('SELECT payload FROM station_experiment_chunks WHERE experiment_id=?1 AND offset=?2')
    .bind(row.id,result.offset).first();
  if ((row.result_meta && row.result_meta!==meta) || (existing && existing.payload!==payload)) throw Error('Conflicting result replay');
  // Guard the INSERT as well as prechecks: concurrent requests cannot mix result metadata.
  await db.batch([
    db.prepare(`UPDATE station_experiments SET result_meta=COALESCE(result_meta,?1) WHERE id=?2 AND status!='cancelled'`).bind(meta,row.id),
    db.prepare(`INSERT INTO station_experiment_chunks (experiment_id,offset,sample_count,payload,received_at)
      SELECT id,?2,?3,?4,?5 FROM station_experiments WHERE id=?1 AND result_meta=?6 AND status!='cancelled'
      ON CONFLICT(experiment_id,offset) DO NOTHING`).bind(row.id,result.offset,result.samples.length,payload,now.toISOString(),meta),
    db.prepare(`UPDATE station_experiments SET status=CASE WHEN
      (SELECT COUNT(*) FROM station_experiment_chunks WHERE experiment_id=?1)=?2 THEN 'completed' ELSE 'receiving' END
      WHERE id=?1 AND result_meta=?3 AND status!='cancelled'`).bind(row.id,Math.max(1,Math.ceil(input.total_samples/100)),meta)
  ]);
  const saved=await db.prepare(`SELECT c.payload,e.result_meta FROM station_experiment_chunks c
    JOIN station_experiments e ON e.id=c.experiment_id WHERE c.experiment_id=?1 AND c.offset=?2`).bind(row.id,result.offset).first();
  if (saved?.payload!==payload || saved.result_meta!==meta) throw Error('Conflicting result replay');
  const chunks=await db.prepare('SELECT offset,sample_count FROM station_experiment_chunks WHERE experiment_id=?1 ORDER BY offset LIMIT 6').bind(row.id).all();
  let next=0;
  for (const chunk of chunks.results) {
    if (chunk.offset!==next) break;
    next+=chunk.sample_count;
  }
  return {id:row.id,next_offset:next,complete:next===input.total_samples && chunks.results.length===Math.max(1,Math.ceil(input.total_samples/100))};
}
