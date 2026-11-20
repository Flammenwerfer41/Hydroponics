export const stepNames={idle:'대기 · 회복',cpu_load:'CPU 부하',wifi_connect:'Wi-Fi 연결',network_probe:'HTTPS 시험 전송',wifi_stop:'Wi-Fi 정지',bme_measure:'BME280 환경센서 반복 측정'};
export const outcomeNames={completed:'정상 종료',interrupted:'재부팅·기한 초과로 중단',expired:'유효기간 만료',clock_unavailable:'시각 미확인',battery_not_ready:'시작 전압 조건 미충족',backlog_pending:'미전송 관측 우선 처리',sampler_failed:'샘플러 시작 실패',low_voltage:'저전압 중단',adc_unavailable:'전압 계측 실패',sample_limit:'표본 한도 도달',network_failed:'시험 통신 실패',sensor_failed:'BME280 센서 측정 실패'};
const immediateReasons={
  interrupted:'재부팅 또는 기한 초과로 중단',experiment_not_completed:'실험이 정상 종료되지 않아 건너뜀',
  clock_unavailable:'시각 미확인',emergency:'비상 절전 상태',battery_unavailable:'배터리 전압 미확인',
  battery_low:'즉시 전송 전압 조건 미충족',window_too_short:'다음 관측까지 시간이 부족해 건너뜀',
  wifi_failed:'Wi-Fi 재연결 실패',wifi_start_failed:'Wi-Fi 시작 실패',wifi_connect_failed:'Wi-Fi 재연결 호출 오류',
  wifi_ip_timeout:'Wi-Fi 재연결·IP 대기 시간 초과',deadline:'전송 시간 한도 도달',
  http_failed:'HTTPS 전송 또는 응답 확인 실패',storage_error:'로컬 저장 실패',
  attempt_limit:'전송 시도 한도 도달',completed:'같은 기상에서 전량 확인'
};
export function immediateUploadSummary(value) {
  let report;
  try { report=JSON.parse(value); } catch { return '즉시 전송 진단 없음'; }
  if (report?.schema_version!==1 || !Object.hasOwn(immediateReasons,report.reason)) return '즉시 전송 진단 없음';
  const info=[`즉시 전송: ${immediateReasons[report.reason]}`];
  if(Number.isInteger(report.battery_mv)) info.push(`배터리 ${(report.battery_mv/1000).toFixed(3)}V`);
  if(Number.isInteger(report.wifi_ms)) info.push(`Wi-Fi ${(report.wifi_ms/1000).toFixed(2)}초`);
  if(Number.isInteger(report.elapsed_ms)) info.push(`전체 ${(report.elapsed_ms/1000).toFixed(2)}초`);
  if(Number.isInteger(report.http_attempts)) info.push(`HTTPS ${report.http_attempts}회`);
  if(Number.isInteger(report.confirmed_samples)) info.push(`즉시 확인 ${report.confirmed_samples}표본`);
  return info.join(' · ');
}
export const template={schema_version:1,sample_interval_ms:50,steps:[
  {action:'idle',duration_ms:2000},{action:'cpu_load',duration_ms:2000},{action:'wifi_connect',duration_ms:8000},
  {action:'network_probe',duration_ms:6000},{action:'wifi_stop',duration_ms:100},{action:'idle',duration_ms:5000}]};
export function summarizeRecipe(recipe) {
  if (recipe?.schema_version!==1 || !Number.isInteger(recipe.sample_interval_ms) || recipe.sample_interval_ms<20 || recipe.sample_interval_ms>1000 || recipe.sample_interval_ms%10 ||
      !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length>8) throw Error('규격·샘플 간격·단계 개수를 확인하세요.');
  let ms=0,radio=false,connections=0,probes=0,sensors=0;
  for (const s of recipe.steps) {
    if (!s || !Object.hasOwn(stepNames,s.action) || !Number.isInteger(s.duration_ms) || s.duration_ms<100 || s.duration_ms>15000) throw Error('허용된 단계와 100~15,000ms 길이를 사용하세요.');
    ms+=s.duration_ms;
    if(s.action==='wifi_connect'){if(radio || ++connections>1 || s.duration_ms<1000) throw Error('Wi-Fi 연결은 한 번만 허용합니다.');radio=true;}
    if(s.action==='network_probe' && (!radio || ++probes>1 || s.duration_ms<1000)) throw Error('연결 후 시험 전송을 한 번만 허용합니다.');
    if(s.action==='wifi_stop'){if(!radio)throw Error('Wi-Fi 연결 단계가 먼저 필요합니다.');radio=false;}
    if(s.action==='bme_measure' && (radio || ++sensors>1 || s.duration_ms<1000)) throw Error('BME280 측정은 Wi-Fi가 꺼진 구간에서 1초 이상, 한 단계만 허용합니다.');
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
    for(const s of chunk.samples){points.push({time:s[0]/1e6,step:s[1],raw:s[2],voltage:s[3]===null?null:s[3]/1000,gap,sensorPhase:s[4]??null});gap=false;}
    expected=chunk.offset+chunk.samples.length;
  }
  const values=points.filter(p=>Number.isFinite(p.voltage)).map(p=>p.voltage);
  return {meta,points,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};
}
export function sensorPhaseCounts(points,step) {
  const counts={between:0,conversion:0,read:0};
  for (const p of points) if (p.step===step && Number.isFinite(p.voltage)) {
    if(p.sensorPhase===0) counts.between++;
    if(p.sensorPhase===1) counts.conversion++;
    if(p.sensorPhase===2) counts.read++;
  }
  return counts;
}
