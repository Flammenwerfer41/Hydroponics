// Synthetic loopback-only UI fixture. No cloud credentials, production writes or firmware uploads.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
const root=fileURLToPath(new URL('../docs/',import.meta.url));
const scenario=process.argv[2] || 'normal';
if(!['normal','emergency','legacy'].includes(scenario)) throw Error('Invalid fixture');
const hash='a'.repeat(64), events=[];
const station={device_id:'preview-station',hardware:'firebeetle2-esp32c6-v1.2',target_sha256:hash,
  reported_at:new Date().toISOString(),normal_interval_seconds:300,schedule_revision:1,
  reported_status:JSON.stringify({firmware_version:scenario==='legacy'?'1.0.1':'1.1.0',mode:scenario==='emergency'?'emergency':'normal',
    ota_attempts:0,ota_next_attempt:0,ota_sha256:'',queued:0,dropped:0,
    ...(scenario==='legacy'?{}:{schedule:{normal_interval_seconds:300,applied_interval_seconds:scenario==='emergency'?3600:300,revision:1,
      reason:scenario==='emergency'?'emergency_voltage':'manual_setting'},power_mode:scenario==='emergency'?'emergency':'normal',
      battery_voltage:scenario==='emergency'?3.2:3.55,automatic_ota_min_voltage:3.6,manual_ota_min_voltage:3.5})})};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:8766');
  const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(url.pathname==='/admin/api/stations' && req.method==='GET') return json({stations:[station],releases:[{version:'1.1.1',sha256:hash}],readiness:{storage:true,signing_key:true}});
  if(url.pathname==='/admin/api/stations/preview-station/events') return json({events});
  if(url.pathname==='/admin/api/stations/preview-station' && req.method==='POST') {
    try {
      let raw=''; for await (const chunk of req) { raw+=chunk; if(raw.length>4096) return json({},413); }
      const input=JSON.parse(raw);
      if(input.action==='schedule' && [300,600,900,1800,3600].includes(input.normal_interval_seconds)) {
        station.normal_interval_seconds=input.normal_interval_seconds; station.schedule_revision++;
      } else if(input.action==='manual_ota') { station.manual_ota_expires_at=new Date(Date.now()+3600000).toISOString(); station.manual_ota_sha256=hash; }
      else return json({error:'Unsupported preview action'},400);
      events.unshift({action:input.action,details:JSON.stringify(input),created_at:new Date().toISOString()});
      return json({preview:true});
    } catch {return json({},400);}
  }
  if(url.pathname.startsWith('/admin/api/')) return json({},404);
  try {
    const path=resolve(root,'.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
    if(!path.startsWith(resolve(root)+sep)) return json({},403);
    let body=await readFile(path);
    if(extname(path)==='.html') body=body.toString().replace('<body>','<body><p>LOCAL PREVIEW · synthetic data · NOT DEPLOYED</p>');
    res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[extname(path)]||'application/octet-stream','Cache-Control':'no-store'}); res.end(body);
  } catch {res.writeHead(404);res.end();}
}).listen(8766,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8766/admin/station/ ('+scenario+')'));
