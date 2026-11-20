import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {template,summarizeRecipe,traceModel,runLabel,immediateUploadSummary,sensorPhaseCounts,outcomeNames} from '../../docs/admin/station/experiment-model.mjs';
import {setupExperiments} from '../../docs/admin/station/experiments.js';
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
const sensorStep={action:'bme_measure',duration_ms:7000};
const sensorRecipe={schema_version:1,sample_interval_ms:20,steps:[
  {action:'idle',duration_ms:2000},sensorStep,{action:'idle',duration_ms:2000}]};
test('sensor-only recipe checks match the backend, with one bounded Wi-Fi-off action',()=>{
  assert.deepEqual(summarizeRecipe(sensorRecipe),{seconds:11,interval:20,bound:555});
  assert.deepEqual(validateRecipe(sensorRecipe),sensorRecipe);
  for(const steps of [
    [{...sensorStep,duration_ms:999}],
    [{...sensorStep,duration_ms:1000},{...sensorStep,duration_ms:1000}],
    [{action:'wifi_connect',duration_ms:1000},sensorStep,{action:'wifi_stop',duration_ms:100}]
  ]){
    assert.throws(()=>summarizeRecipe({...sensorRecipe,steps}),/BME280/);
    assert.throws(()=>validateRecipe({...sensorRecipe,steps}));
  }
});
test('sensor phase markers count only valid voltages without relabeling older samples',()=>{
  const model=traceModel({experiment:{},chunks:[{offset:0,samples:[
    [0,0,2200,3650],[100,1,2200,3650,0],[200,1,2200,3649,1],[300,1,2200,3648,2],[400,1,null,null,2]
  ]}]});
  assert.equal(model.points[0].sensorPhase,null);
  assert.deepEqual(sensorPhaseCounts(model.points,1),{between:1,conversion:1,read:1});
  assert.match(outcomeNames.sensor_failed,/측정 실패/);
});
test('experiment approval takes two explicit clicks, binds the device and revision, and cancels locally',async t=>{
  class Element {
    children=[]; handlers={}; attributes={}; value=''; hidden=false;
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    setAttribute(key,value){this.attributes[key]=value;}
    addEventListener(event,fn){(this.handlers[event]??=[]).push(fn);}
    async emit(event){await Promise.all((this.handlers[event]||[]).map(fn=>fn()));}
    focus(){}
  }
  const elements=new Map(),orig=globalThis.document;
  t.after(()=>{if(orig===undefined)delete globalThis.document;else globalThis.document=orig;});
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  globalThis.document={createElement:()=>new Element(),getElementById:get};
  const device=new Element();device.value='balcony-weather-01';
  const record={id:'123',title:'4. 환경센서 전압 변화',revision:2,recipe:JSON.stringify(sensorRecipe)};
  const mutations=[];
  const controls=setupExperiments({device,getStatus:()=>null,run:fn=>fn(),api:async(path,body)=>{
    if(body)mutations.push({path,body});
    return {drafts:mutations.length?[]:[record],experiments:[]};
  }});
  await controls.refresh();
  const box=get('draft-list').children[0],prepare=box.children.find(n=>n.textContent==='실행 승인');
  const panel=box.children.at(-1),commit=panel.children.find(n=>n.textContent==='실험 실행 확정');
  assert.equal(panel.hidden,true);
  await prepare.emit('click');
  assert.equal(panel.hidden,false);assert.equal(mutations.length,0);
  assert.match(panel.children[0].textContent,/balcony-weather-01.*4\. 환경센서 전압 변화.*수정본 2/);
  await panel.children.find(n=>n.textContent==='승인 취소').emit('click');
  assert.equal(panel.hidden,true);assert.equal(mutations.length,0);
  await prepare.emit('click');device.value='other';await device.emit('change');
  assert.equal(panel.hidden,true);await assert.rejects(commit.emit('click'),/바뀌었습니다/);assert.equal(mutations.length,0);
  device.value='balcony-weather-01';await prepare.emit('click');await commit.emit('click');
  assert.deepEqual(mutations,[{path:'/balcony-weather-01',body:{action:'experiment_approve',id:'123',revision:2}}]);
});
