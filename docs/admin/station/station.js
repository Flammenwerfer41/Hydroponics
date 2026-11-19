import { scheduleLabel, staleMilliseconds } from '../../weather/schedule.mjs?v=20261117-policy';
import { setupExperiments } from './experiments.js?v=20261119-v2';
const device = document.querySelector("#device"), releases = document.querySelector("#release");
const notice = document.querySelector("#notice");
let stations = [], releaseRows = [], busy = false;
const experiments=setupExperiments({api,run,device,getStatus:()=>{
  const row=stations.find(s=>s.device_id===device.value);return row?.reported_status?JSON.parse(row.reported_status):null;
}});
async function api(path = "", body) {
  const response = await fetch(`/admin/api/stations${path}`, { credentials: "same-origin",
    method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (response.redirected || !response.headers.get("Content-Type")?.includes("application/json"))
    throw new Error("로그인 세션이 만료되었습니다. 페이지를 새로고침해 다시 로그인하세요.");
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? "관리자 인증이 필요합니다. 로그인 후 다시 열어주세요." : `요청 실패 (${response.status})`);
  return response.json();
}
function showState() {
  const row = stations.find(item => item.device_id === device.value);
  const status = row?.reported_status ? JSON.parse(row.reported_status) : null;
  const target = releaseRows.find(item => item.sha256 === row?.target_sha256);
  document.querySelector('#reported-version').textContent=status?.firmware_version || '미확인';
  document.querySelector('#reported-time').textContent=row?.reported_at?new Date(row.reported_at).toLocaleString('ko-KR',{timeZone:'Asia/Tokyo'})+' JST':'실제 장치 보고 대기';
  document.querySelector('#target-version').textContent=target?.version || '승인 없음';
  const modes={normal:'통상',emergency:'비상 절전',maintenance:'유지보수'};
  document.querySelector('#power-mode').textContent=modes[status?.mode] || '미확인';
  document.querySelector('#power-detail').textContent=status?.schedule?`${typeof status.battery_voltage==='number'?status.battery_voltage.toFixed(3)+'V':'전압 미확인'} · ${scheduleLabel(status.schedule)}`:'이전 펌웨어 · 확장 상태 미보고';
  const exp=status?.experiment;
  document.querySelector('#experiment-state').textContent=({idle:'대기',queued:'장치 저장됨',running:'실행 보고',result_pending:'전송 대기',storage_error:'저장소 오류'})[exp?.state] || '지원 보고 대기';
  document.querySelector('#experiment-detail').textContent=exp?`${exp.samples}표본 · 결과 전송 ${exp.upload_attempts}/18회 · 마지막 보고 기준`:'2.0.0 설치·상태 보고 후 사용 가능';
  const version=(status?.firmware_version || '0.0.0').split('.').map(Number);
  const since=(major,minor)=>version[0]>major || version[0]===major && version[1]>=minor;
  const features=[['정각 관측 · 미전송 큐 · 서명 OTA',Boolean(status)],['통상/비상 주기 · 자동 3.6V / 수동 3.5V OTA',since(1,1)],['일별 천문박명 계산 · 야간 마감',since(1,2)],['지정 절차 실험 · 개별 ADC · 중복 실행 방지',since(2,0)]];
  document.querySelector('#capabilities').replaceChildren(...features.map(([label,enabled])=>{const li=document.createElement('li');li.textContent=`${enabled?'지원 버전':'업데이트 필요'} · ${label}`;return li;}));
  let message = !status ? "장치 상태 보고 대기 — 아직 기기 연결을 확인하지 못했습니다."
    : !target ? `최근 보고 버전 ${status.firmware_version} · 승인된 배포 없음`
    : status.firmware_version === target.version ? `장치가 ${target.version} 실행을 보고했습니다.`
    : status.ota_sha256 === target.sha256 && status.ota_attempts >= 3 ? `${target.version} · 시도 한도 3회 도달. 원인을 확인하세요.`
    : `${status.firmware_version} → ${target.version} · 적용 대기 (기상 시 확인 / 전압·버전·재시도 조건 충족 필요)`;
  if (row?.reported_at && Date.now() - Date.parse(row.reported_at) > staleMilliseconds(status?.schedule))
    message += " · 관측 주기 기준으로 오래된 보고입니다. 현재 상태로 단정하지 마세요.";
  if (status?.schedule && target && status.firmware_version !== target.version) {
    const minimum = row.manual_ota_sha256 === row.target_sha256 && Date.parse(row.manual_ota_expires_at) > Date.now() ? status.manual_ota_min_voltage : status.automatic_ota_min_voltage;
    message += status.power_mode === 'emergency' ? ' · 비상 절전으로 OTA 보류'
      : status.battery_voltage === null ? ' · 전압 확인 불가로 OTA 보류'
      : status.battery_voltage < minimum ? ` · 마지막 보고 ${status.battery_voltage.toFixed(3)}V / ${minimum}V 미만으로 보류`
      : ` · 전압 조건 충족 (${minimum}V 이상), 다른 OTA 조건은 별도 확인`;
  }
  const schedule = status?.schedule;
  const pending = row?.schedule_revision > (schedule?.revision ?? 0);
  document.querySelector('#schedule-state').textContent = `${scheduleLabel(schedule)} · 요청: ${row?.normal_interval_seconds ? row.normal_interval_seconds / 60 + '분' : '미설정'} · ${!schedule ? '지원 펌웨어 보고 대기' : pending ? '설정 적용 대기' : schedule.applied_interval_seconds !== schedule.normal_interval_seconds ? '설정 수신 완료 · 비상 주기 적용' : '적용 완료'}`;
  document.querySelector('#normal-period').value = String(row?.normal_interval_seconds || schedule?.normal_interval_seconds || 900);
  if (status?.ota_sha256 === target?.sha256 && status?.ota_next_attempt > Date.now() / 1000)
    message += ` · 다음 시도 가능 ${new Date(status.ota_next_attempt * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Tokyo" })} JST`;
  document.querySelector("#deployment").textContent = message;
  document.querySelector("#state").textContent = row ? JSON.stringify({
    last_report: row.reported_at, status: row.reported_status ? JSON.parse(row.reported_status) : null,
    target_sha256: row.target_sha256, maintenance_pending_until: row.maintenance_expires_at
  }, null, 2) : "등록된 기상대가 없습니다. 운영 등록 전에는 정상입니다.";
}
async function refresh() {
  const data = await api(); stations = data.stations; releaseRows = data.releases;
  document.querySelector("#readiness").textContent = `서버 저장소: ${data.readiness.storage ? "준비됨" : "미설정"} · 서명 공개키: ${data.readiness.signing_key ? "설정됨" : "미설정"} · 승인이나 HTTP 성공만으로 설치 완료를 판정하지 않습니다.`;
  const previous = device.value, previousRelease = releases.value;
  device.replaceChildren(...stations.map(row => new Option(row.device_id, row.device_id)));
  releases.replaceChildren(...data.releases.map(row => new Option(`${row.version} · ${row.sha256.slice(0, 12)}`, row.sha256)));
  if (stations.some(row => row.device_id === previous)) device.value = previous;
  if (data.releases.some(row => row.sha256 === previousRelease)) releases.value = previousRelease;
  showState();
  await showEvents();
  await experiments.refresh();
}
async function showEvents() {
  const selected = device.value;
  const data = selected ? await api(`/${encodeURIComponent(selected)}/events`) : { events: [] };
  if (device.value !== selected) return;
  document.querySelector("#events").replaceChildren(...data.events.map(event => {
    const item = document.createElement("li");
    const labels = { register: "등록", approve: "배포 승인", pause: "배포 중지", maintenance: "유지보수 요청", stop: "유지보수 종료", schedule: '관측 주기 설정', manual_ota: '수동 OTA 요청' };
    const details = event.details ? JSON.parse(event.details) : null;
    const detail = details?.normal_interval_seconds ? `${details.normal_interval_seconds / 60}분` : (details?.sha256 || event.sha256)?.slice(0, 12) || '—';
    item.textContent = `${new Date(event.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Tokyo" })} JST · ${labels[event.action] || event.action} · ${detail}`;
    return item;
  }));
}
async function run(work) {
  if (busy) return; busy = true;
  document.querySelectorAll("button").forEach(button => button.disabled = true);
  try { await work(); notice.textContent = "처리 완료. 장치의 실제 적용은 다음 통신 후 상태 보고에서 확인하세요."; }
  catch (error) { notice.textContent = error.message; }
  finally { busy = false; document.querySelectorAll("button").forEach(button => button.disabled = false); }
}
document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => run(async () => {
  if (!device.value) throw new Error("기상대 등록이 먼저 필요합니다.");
  const action = button.dataset.action;
  if (action === "approve" && (!releases.value || !confirm("선택한 펌웨어를 이 기상대에 자동 배포할까요?"))) return;
  if (action === 'manual_ota' && (!releases.value || !confirm('이미 승인된 선택 버전에 한해, 1시간 동안 3.5V 이상에서 OTA를 허용할까요? 비상 상태와 재시도 제한은 유지됩니다.'))) return;
  await api(`/${encodeURIComponent(device.value)}`, { action, sha256: releases.value }); await refresh();
})));
document.querySelector('#save-period').addEventListener('click', () => run(async () => {
  if (!device.value) throw new Error('기상대 등록이 먼저 필요합니다.');
  await api(`/${encodeURIComponent(device.value)}`, {action:'schedule', normal_interval_seconds:Number(document.querySelector('#normal-period').value)});
  await refresh();
}));
document.querySelector("#register").addEventListener("click", () => run(async () => {
  const file = document.querySelector("#manifest").files[0];
  const binary = document.querySelector("#firmware").files[0];
  if (!device.value || !file || file.size > 4096 || !binary || binary.size < 512 || binary.size > 0x1b0000)
    throw new Error("장치, 4KB 이하 manifest JSON, 유효한 앱 BIN 파일을 선택하세요.");
  const manifest = JSON.parse(await file.text());
  if (manifest.size !== binary.size) throw new Error("manifest와 BIN 파일 크기가 다릅니다.");
  const response = await fetch(`/admin/api/stations/${encodeURIComponent(device.value)}/firmware`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream",
      "X-Station-Manifest": JSON.stringify(manifest) }, body: binary, signal: AbortSignal.timeout(60000)
  });
  if (!response.ok || response.redirected || !response.headers.get("Content-Type")?.includes("application/json"))
    throw new Error(`업로드 실패 (${response.status}). 인증·서명·파일 일치를 확인하세요. 자동 재시도하지 않습니다.`);
  await refresh();
}));
device.addEventListener("change", () => run(async () => { showState(); await showEvents(); await experiments.refresh(); }));
document.querySelector("#refresh").addEventListener("click", () => run(refresh));
run(refresh);
