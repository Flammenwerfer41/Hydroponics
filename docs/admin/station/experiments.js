import {template,summarizeRecipe,stepNames,outcomeNames,runLabel,traceModel,immediateUploadSummary,sensorPhaseCounts} from './experiment-model.mjs?v=20261120-bme-test';
const el=id=>document.getElementById(id);
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function setupExperiments({api,run,device,getStatus}) {
  let draft=null,selected=null,data=null,approval=null;
  const path=()=>`/${encodeURIComponent(device.value)}`;
  function clearApproval() {
    if(!approval)return;
    approval.panel.hidden=true;
    approval.prepare.setAttribute('aria-expanded','false');
    approval=null;
  }
  function edit(row=null) {
    clearApproval();
    if(row)el('experiment-editor').open=true;
    draft=row?.approved_id?null:row;
    el('experiment-title').value=row?.title || '통신 부하와 전압 회복';
    el('experiment-purpose').value=row?.purpose || '대기, CPU 부하, Wi-Fi 연결·전송, 정지 후 회복 전압을 비교합니다.';
    el('experiment-json').value=JSON.stringify(row?JSON.parse(row.recipe):template,null,2);
    el('draft-edit-state').textContent=draft?`저장된 초안 · 수정본 ${draft.revision}`:'새 초안 · 저장만으로는 실행되지 않습니다.';
    preview();
  }
  function preview() {
    try {
      const recipe=JSON.parse(el('experiment-json').value), info=summarizeRecipe(recipe);
      el('recipe-summary').textContent=`${info.seconds}초 계획 · ${info.interval}ms 간격 · 표본 상한 ${info.bound}개 · 시작 3.5V 이상 / 보호 평균 3.4V 미만 중단`;
      el('recipe-steps').replaceChildren(...recipe.steps.map(s=>node('li',`${stepNames[s.action]} · ${s.duration_ms/1000}초`)));
    }catch(e){el('recipe-summary').textContent=e.message;el('recipe-steps').replaceChildren();}
  }
  function button(label,fn){const b=node('button',label);b.type='button';b.addEventListener('click',()=>run(fn));return b;}
  function draftApproval(d,info,requested) {
    const prepare=node('button','실행 승인');prepare.type='button';
    const panel=node('div',undefined,'callout');panel.id=`experiment-approval-${d.id}`;panel.hidden=true;
    prepare.setAttribute('aria-controls',panel.id);prepare.setAttribute('aria-expanded','false');
    const description=node('p',`${requested}에서 “${d.title}” 수정본 ${d.revision}을 실행 승인할까요?`);
    description.id=`${panel.id}-description`;
    panel.setAttribute('role','group');panel.setAttribute('aria-labelledby',description.id);
    const details=node('p',`${info.seconds}초 · ${info.interval}ms · 최대 ${info.bound}표본. 장치에 저장된 뒤에는 취소가 즉시 적용되지 않습니다.`);
    const apply=button('실험 실행 확정',async()=>{
      if(approval?.panel!==panel || device.value!==requested) {clearApproval();throw Error('대상 기상대 또는 초안이 바뀌었습니다. 다시 확인하세요.');}
      clearApproval();
      await api(`/${encodeURIComponent(requested)}`,{action:'experiment_approve',id:d.id,revision:d.revision});
      if(draft?.id===d.id)edit();
      await refresh();
    });
    const cancel=node('button','승인 취소');cancel.type='button';
    cancel.addEventListener('click',()=>{clearApproval();prepare.focus();});
    panel.append(description,details,apply,cancel);
    prepare.addEventListener('click',()=>{
      if(device.value!==requested)return;
      clearApproval();
      approval={panel,prepare};panel.hidden=false;prepare.setAttribute('aria-expanded','true');
      cancel.focus();
    });
    return [prepare,panel];
  }
  async function refresh() {
    clearApproval();
    if(!device.value)return;
    const requested=device.value;
    const result=await api(`${path()}/experiments`);
    if(requested!==device.value)return;
    const drafts=result.drafts.filter(d=>!d.approved_id);
    el('draft-list').replaceChildren(...drafts.map(d=>{
      const box=node('article',undefined,'experiment-item');box.append(node('h3',d.title),node('p',d.purpose),node('p',`초안 · 수정본 ${d.revision}`,'hint'));
      const info=summarizeRecipe(JSON.parse(d.recipe));box.append(node('p',`${info.seconds}초 · ${info.interval}ms · 최대 ${info.bound}표본`));
      box.append(button('초안 편집',async()=>edit(d)),...draftApproval(d,info,requested));return box;
    }));
    if(!drafts.length)el('draft-list').append(node('p','저장된 초안이 없습니다.','hint'));
    el('experiment-list').replaceChildren(...result.experiments.map(r=>{
      const box=node('article',undefined,'experiment-item');const meta=r.result_meta?JSON.parse(r.result_meta):null;
      box.append(node('h3',r.title || `실험 #${r.sequence}`),node('p',runLabel(r,getStatus())),
        node('p',`${new Date(r.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Tokyo'})} JST${meta?` · ${outcomeNames[meta.outcome] || meta.outcome} · 펌웨어 ${meta.firmware_version}`:''}`,'hint'));
      box.append(button('결과 · 그래프',async()=>{selected=r;data=await api(`${path()}/experiments/${r.id}`);renderResult(data,r);}),
        button('새 초안으로 복제',async()=>edit({...r,id:undefined,revision:undefined,approved_id:'clone',title:`${r.title || '실험'} 복제`.slice(0,80)})));
      if(r.status!=='cancelled')box.append(button(r.status==='completed'?'장치 잔여 전송 해제':'취소 · 장치 결과 폐기 요청',async()=>{
        if(!confirm('장치가 이 요청을 받으면 해당 실험의 로컬 미전송 결과를 폐기합니다. 서버에 받은 결과는 남습니다. 오프라인에서 이미 시작된 실험을 즉시 중지할 수 없습니다. 요청할까요?'))return;
        await api(path(),{action:'experiment_cancel',sequence:r.sequence});await refresh();
      }));return box;
    }));
    if(!result.experiments.length)el('experiment-list').append(node('p','승인된 실험이 없습니다.','hint'));
  }
  function renderResult(payload,row){
    el('experiment-result').hidden=false;
    const {meta,points,min,max}=traceModel(payload);
    el('result-heading').textContent=row.title || `실험 #${row.sequence}`;
    el('result-summary').textContent=meta?`${outcomeNames[meta.outcome] || meta.outcome} · ${points.length}/${meta.total_samples}표본 수신 · 실행 펌웨어 ${meta.firmware_version}${min===null?'':` · ${min.toFixed(3)}–${max.toFixed(3)}V`} · ${payload.experiment.status==='completed'?'수집 완료':'부분 결과'}`:'아직 결과가 없습니다. 수신 대기 상태를 실행 완료로 해석하지 마세요.';
    el('immediate-upload-summary').textContent=immediateUploadSummary(payload.experiment.immediate_upload);
    const graph=el('experiment-chart');graph.replaceChildren();
    if(min===null){graph.append(node('p','유효한 전압 표본이 아직 없습니다.'));return;}
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 900 310');svg.setAttribute('role','img');svg.setAttribute('aria-label','실험 단계별 배터리 전압 시계열');
    const draw=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;svg.append(n);return n;};
    const recipe=JSON.parse(payload.experiment.recipe),colors=['#dcefe7','#fcebcf','#dfeafa','#f2ddec','#e8e6fa','#dcefe7','#fcebcf','#dfeafa'];
    const end=Math.max(1,...points.map(p=>p.time),...(meta?.step_results || []).map(s=>s[1]/1e6));
    const low=min-.01,high=Math.max(max+.01,low+.03),x=t=>65+810*t/end,y=v=>250-(v-low)/(high-low)*210;
    (meta?.step_results || []).forEach((s,i)=>{if(s[1]>s[0]){
      draw('rect',{x:x(s[0]/1e6),y:40,width:Math.max(1,x(s[1]/1e6)-x(s[0]/1e6)),height:210,fill:colors[i]});
      draw('text',{x:x((s[0]+s[1])/2e6),y:28,'text-anchor':'middle','font-size':14,fill:'#14352e'},String(i+1));
    }});
    for(let i=0;i<=4;i++){const v=low+(high-low)*i/4;draw('line',{x1:65,x2:875,y1:y(v),y2:y(v),stroke:'#b9ccc3'});draw('text',{x:5,y:y(v)+5,'font-size':14,fill:'#14352e'},v.toFixed(3)+'V');}
    for(let i=0;i<=5;i++)draw('text',{x:x(end*i/5),y:280,'font-size':14,'text-anchor':i===5?'end':'middle',fill:'#14352e'},(end*i/5).toFixed(1)+'s');
    let d='',pen=false;
    for(const p of points){if(p.gap)pen=false;if(p.voltage===null){pen=false;continue;}d+=`${pen?'L':'M'}${x(p.time).toFixed(2)},${y(p.voltage).toFixed(2)} `;pen=true;}
    draw('path',{d,fill:'none',stroke:'#12745b','stroke-width':2});
    for(const p of points)if(Number.isFinite(p.voltage) && (p.sensorPhase===1 || p.sensorPhase===2))
      draw('circle',{cx:x(p.time),cy:y(p.voltage),r:2.6,fill:p.sensorPhase===1?'#8f5500':'#56309e'});
    if(points.length===1)draw('circle',{cx:x(points[0].time),cy:y(points[0].voltage),r:4,fill:'#12745b'});
    graph.append(svg);
    const legend=node('ol',undefined,'trace-legend');recipe.steps.forEach((s,i)=>legend.append(node('li',`${i+1}. ${stepNames[s.action]} · ${meta?.step_results[i]?.[2]?'완료':'미완료/미실행'}`)));graph.append(legend);
    const sensorStep=recipe.steps.findIndex(s=>s.action==='bme_measure');
    if(sensorStep!==-1) {
      const counts=sensorPhaseCounts(points,sensorStep);
      graph.append(node('p',`센서 구간의 유효 전압 표본: 측정 사이 ${counts.between}개 · 명령/변환 대기 ${counts.conversion}개(황갈색) · I²C 읽기/보정 ${counts.read}개(보라색). 표본 개수는 센서 측정 횟수가 아닙니다.`,'hint'));
    }
  }
  el('new-experiment').addEventListener('click',()=>edit());
  el('preview-experiment').addEventListener('click',preview);
  el('save-experiment').addEventListener('click',()=>run(async()=>{
    const recipe=JSON.parse(el('experiment-json').value);summarizeRecipe(recipe);
    const result=await api(path(),{action:'experiment_draft',...(draft?.id?{id:draft.id,revision:draft.revision}:{}),title:el('experiment-title').value,purpose:el('experiment-purpose').value,recipe});
    edit(result.draft);await refresh();
  }));
  el('refresh-experiments').addEventListener('click',()=>run(refresh));
  el('download-experiment').addEventListener('click',()=>{
    if(!data)return;const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=node('a');a.href=url;a.download=`experiment-${selected.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  device.addEventListener('change',()=>{edit();data=null;selected=null;el('experiment-result').hidden=true;});
  edit();return {refresh};
}
