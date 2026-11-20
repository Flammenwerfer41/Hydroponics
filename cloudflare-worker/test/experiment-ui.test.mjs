import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {template,summarizeRecipe,traceModel,runLabel,immediateUploadSummary} from '../../docs/admin/station/experiment-model.mjs';
import {validateRecipe} from '../src/station/experiments.js';
test('UI summary and server agree on the default experiment limits',()=>{
  assert.deepEqual(validateRecipe(template),template);
  assert.deepEqual(summarizeRecipe(template),{seconds:23.1,interval:50,bound:470});
  assert.throws(()=>summarizeRecipe({...template,sample_interval_ms:20}));
  assert.throws(()=>summarizeRecipe({...template,steps:[{action:'network_probe',duration_ms:2000}]}));
});
test('trace preserves missing voltage and missing chunks instead of bridging them',()=>{
  const model=traceModel({experiment:{result_meta:JSON.stringify({total_samples:202})},chunks:[
    {offset:200,samples:[[3000000,1,2200,3600]]},{offset:0,samples:[[0,0,2200,3500],[100000,0,null,null]]}]});
  assert.equal(model.points[1].voltage,null);assert.equal(model.points[2].gap,true);
  assert.equal(model.min,3.5);assert.equal(model.max,3.6);
  assert.equal(traceModel({experiment:{},chunks:[]}).min,null);
});
test('UI does not equate assignment, device report, upload completion and successful execution',()=>{
  const run={id:'x',status:'queued',expires_at:'2026-11-20T00:00:00Z'};
  assert.match(runLabel(run,null,Date.parse('2026-11-19')),/수신 대기/);
  assert.match(runLabel(run,{experiment:{id:'x',state:'queued'}}),/장치 저장/);
  assert.match(runLabel({...run,status:'completed'}),/수집 완료/);
  const html=readFileSync(new URL('../../docs/admin/station/index.html',import.meta.url),'utf8');
  assert.match(html,/초안 저장 · 실행하지 않음/);assert.match(html,/실행 보고 버전/);assert.match(html,/승인된 목표 버전/);
});
test('immediate diagnostics distinguish successful upload, missing evidence and Wi-Fi/IP timeout',()=>{
  const report={schema_version:1,reason:'wifi_ip_timeout',battery_mv:3818,wifi_ms:8000,
    elapsed_ms:8123,http_attempts:0,confirmed_samples:0};
  assert.match(immediateUploadSummary(JSON.stringify(report)),/IP 대기 시간 초과.*3\.818V.*8\.00초.*HTTPS 0회.*0표본/);
  assert.match(immediateUploadSummary(JSON.stringify({...report,reason:'completed',http_attempts:6,confirmed_samples:580})),
    /전량 확인.*HTTPS 6회.*580표본/);
  for(const absent of [null,undefined,'corrupt data','{"schema_version":1,"reason":"__proto__"}'])
    assert.equal(immediateUploadSummary(absent),'즉시 전송 진단 없음');
});
