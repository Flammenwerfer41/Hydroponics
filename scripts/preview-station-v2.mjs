// Loopback-only synthetic UI fixture; no credentials or production mutations.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
import {template} from '../docs/admin/station/experiment-model.mjs';
const root=fileURLToPath(new URL('../docs/',import.meta.url));
const now=new Date().toISOString(),id='00000000-0000-0000-0000-000000000001',drafts=[];
const result={schema_version:1,id,firmware_version:'2.0.0',outcome:'completed',total_samples:462,
  step_results:[[0,2000000,true],[2000000,4000000,true],[4000000,12000000,true],[12000000,18000000,true],[18000000,18100000,true],[18100000,23100000,true]]};
const experiments=[{id,sequence:1,title:'합성 예제 · 전압 회복',purpose:'화면 검증용 가상 데이터',recipe:JSON.stringify(template),status:'completed',created_at:now,expires_at:now,result_meta:JSON.stringify(result)}];
const points=Array.from({length:462},(_,i)=>[i*50000,i<40?0:i<80?1:i<240?2:i<360?3:i<362?4:5,2200,Math.round(3700-(i>=80&&i<362?45:0)+2*Math.sin(i/7))]);
const station={device_id:'preview-station',hardware:'firebeetle2-esp32c6-v1.2',reported_at:now,target_sha256:null,normal_interval_seconds:300,schedule_revision:1,
  reported_status:JSON.stringify({firmware_version:'2.0.0',mode:'normal',power_mode:'normal',battery_voltage:3.7,queued:0,dropped:0,ota_attempts:0,ota_sha256:'',ota_next_attempt:0,automatic_ota_min_voltage:3.6,manual_ota_min_voltage:3.5,
    schedule:{normal_interval_seconds:300,applied_interval_seconds:300,revision:1,reason:'manual_setting'},
    experiment:{schema_version:1,available:true,sequence:1,state:'idle',id,outcome:'completed',samples:462,upload_attempts:5}})};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:8767');
  const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(url.pathname==='/admin/api/stations')return json({stations:[station],releases:[{version:'2.0.0',sha256:'a'.repeat(64)}],readiness:{storage:true,signing_key:true}});
  if(url.pathname.endsWith('/events'))return json({events:[]});
  if(url.pathname.endsWith('/experiments'))return json({experiments,drafts});
  if(url.pathname.endsWith(`/experiments/${id}`))return json({experiment:experiments[0],chunks:Array.from({length:5},(_,i)=>({offset:i*100,samples:points.slice(i*100,(i+1)*100)}))});
  if(url.pathname==='/admin/api/stations/preview-station' && req.method==='POST'){
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)return json({},413);}
    const b=JSON.parse(raw);
    if(b.action==='experiment_draft'){
      let d=drafts.find(d=>d.id===b.id);if(!d){d={id:crypto.randomUUID(),revision:0,created_at:now};drafts.push(d);}
      Object.assign(d,{title:b.title,purpose:b.purpose,recipe:JSON.stringify(b.recipe),revision:d.revision+1});return json({draft:d});
    }
    if(b.action==='experiment_approve'){
      const d=drafts.find(d=>d.id===b.id);d.approved_id=crypto.randomUUID();experiments.unshift({...d,id:d.approved_id,status:'queued',sequence:2,expires_at:new Date(Date.now()+3600000).toISOString()});return json({preview:true});
    }
    return json({preview:true});
  }
  if(url.pathname.startsWith('/admin/api/'))return json({},404);
  try{
    const path=resolve(root,'.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
    if(!path.startsWith(resolve(root)+sep))return json({},403);
    let body=await readFile(path);if(extname(path)==='.html')body=body.toString().replace('<body>','<body><p>LOCAL PREVIEW · 合成/합성 데이터 · NOT DEPLOYED</p>');
    res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end();}
}).listen(8767,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8767/admin/station/'));
