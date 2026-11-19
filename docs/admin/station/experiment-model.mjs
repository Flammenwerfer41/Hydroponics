export const stepNames={idle:'대기 · 회복',cpu_load:'CPU 부하',wifi_connect:'Wi-Fi 연결',network_probe:'HTTPS 시험 전송',wifi_stop:'Wi-Fi 정지'};
export const outcomeNames={completed:'정상 종료',interrupted:'재부팅·기한 초과로 중단',expired:'유효기간 만료',clock_unavailable:'시각 미확인',battery_not_ready:'시작 전압 조건 미충족',backlog_pending:'미전송 관측 우선 처리',sampler_failed:'샘플러 시작 실패',low_voltage:'저전압 중단',adc_unavailable:'전압 계측 실패',sample_limit:'표본 한도 도달',network_failed:'시험 통신 실패'};
export const template={schema_version:1,sample_interval_ms:50,steps:[
  {action:'idle',duration_ms:2000},{action:'cpu_load',duration_ms:2000},{action:'wifi_connect',duration_ms:8000},
  {action:'network_probe',duration_ms:6000},{action:'wifi_stop',duration_ms:100},{action:'idle',duration_ms:5000}]};
export function summarizeRecipe(recipe) {
  if (recipe?.schema_version!==1 || !Number.isInteger(recipe.sample_interval_ms) || recipe.sample_interval_ms<20 || recipe.sample_interval_ms>1000 || recipe.sample_interval_ms%10 ||
      !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length>8) throw Error('규격·샘플 간격·단계 개수를 확인하세요.');
  let ms=0,radio=false,connections=0,probes=0;
  for (const s of recipe.steps) {
    if (!stepNames[s.action] || !Number.isInteger(s.duration_ms) || s.duration_ms<100 || s.duration_ms>15000) throw Error('허용된 단계와 100~15,000ms 길이를 사용하세요.');
    ms+=s.duration_ms;
    if(s.action==='wifi_connect'){if(radio || ++connections>1 || s.duration_ms<1000) throw Error('Wi-Fi 연결은 한 번만 허용합니다.');radio=true;}
    if(s.action==='network_probe' && (!radio || ++probes>1 || s.duration_ms<1000)) throw Error('연결 후 시험 전송을 한 번만 허용합니다.');
    if(s.action==='wifi_stop'){if(!radio)throw Error('Wi-Fi 연결 단계가 먼저 필요합니다.');radio=false;}
  }
  const bound=Math.ceil(ms/recipe.sample_interval_ms)+recipe.steps.length+2;
  if(radio || ms>60000 || bound>600) throw Error('Wi-Fi 정지, 최대 60초·600표본 조건을 확인하세요.');
  return {seconds:ms/1000,interval:recipe.sample_interval_ms,bound};
}
export function runLabel(run,status,now=Date.now()) {
  if(run.status==='cancelled') return '취소 요청됨 · 장치 수신 전 실행 가능';
  if(run.status==='completed') return '결과 수집 완료';
  if(run.status==='receiving') return '결과 수집 중';
  if(status?.experiment?.id===run.id) {
    if(status.experiment.state==='queued') return '장치 저장 확인 · 실행/결과 대기';
    if(status.experiment.state==='result_pending') return status.experiment.upload_attempts>=18?'결과 전송 한도 도달':'장치 종료 보고 · 결과 전송 대기';
  }
  return Date.parse(run.expires_at)<=now || run.status==='expired'?'전달 기한 만료 · 실행 여부 미확인':'승인됨 · 장치 수신 대기';
}
export function traceModel(data) {
  const meta=data.experiment.result_meta?JSON.parse(data.experiment.result_meta):null;
  const points=[]; let expected=0;
  for(const chunk of [...data.chunks].sort((a,b)=>a.offset-b.offset)) {
    let gap=chunk.offset!==expected;
    for(const s of chunk.samples){points.push({time:s[0]/1e6,step:s[1],raw:s[2],voltage:s[3]===null?null:s[3]/1000,gap});gap=false;}
    expected=chunk.offset+chunk.samples.length;
  }
  const values=points.filter(p=>Number.isFinite(p.voltage)).map(p=>p.voltage);
  return {meta,points,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};
}
