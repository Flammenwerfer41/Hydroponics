const state = { busy: false, data: null };
const element = (id) => document.getElementById(id);

for (let value = 16; value <= 30; value += 1) {
  const option = document.createElement("option");
  option.value = String(value);
  option.textContent = `${value}℃`;
  option.selected = value === 25;
  element("acTemperature").append(option);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function relative(timestamp) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "시각 확인 불가";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
}

function jst(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "--" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

function vpd(temperature, humidity) {
  if (![temperature, humidity].every(Number.isFinite)) return null;
  const saturation = 0.6108 * Math.exp((17.27 * temperature) / (temperature + 237.3));
  return saturation * (1 - humidity / 100);
}

function notice(message, kind = "") {
  element("notice").textContent = message;
  element("notice").className = `notice ${kind}`.trim();
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll("button,input,select").forEach((control) => {
    control.disabled = value;
  });
}

async function api(path, init) {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

function commandLabel(item) {
  if (!item) return "기록 없음";
  if (item.actuator_id === "room-air-conditioner") {
    if (item.command === "power_off") return "운전 정지";
    const modes = { 1: "자동", 2: "냉방", 3: "제습", 4: "송풍", 5: "난방" };
    const fans = { 1: "자동풍량", 2: "약풍", 3: "중풍", 4: "강풍" };
    return `${modes[item.parameters?.mode] || "운전"} ${item.parameters?.temperature ?? "--"}℃ · ${fans[item.parameters?.fan] || ""}`;
  }
  return item.command === "power_on" ? "조명 켜기" : item.command === "power_off" ? "조명 끄기" : item.command;
}

function renderLog(commands) {
  const container = element("commandLog");
  container.replaceChildren();
  if (!commands?.length) {
    container.innerHTML = "<p>아직 조작 기록이 없습니다.</p>";
    return;
  }
  commands.forEach((item) => {
    const row = document.createElement("div");
    row.className = "log-entry";
    const time = document.createElement("time");
    time.textContent = jst(item.requested_at);
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = commandLabel(item);
    const actor = document.createElement("small");
    actor.textContent = item.actor_type === "schedule" ? "자동 스케줄" : (item.actor_id || "관리자");
    detail.append(title, actor);
    const status = document.createElement("span");
    status.className = `log-status ${item.status === "failed" ? "failed" : ""}`;
    status.textContent = item.status === "confirmed" ? "확인됨" : item.status === "failed" ? "실패" : "전송됨";
    row.append(time, detail, status);
    container.append(row);
  });
}

function render(data) {
  state.data = data;
  const temperature = finite(data.sensors?.air_temperature?.value);
  const humidity = finite(data.sensors?.humidity?.value);
  const water = finite(data.sensors?.water_temperature?.value);
  const measured = data.sensors?.air_temperature?.measured_at;
  element("airTemperature").textContent = fixed(temperature);
  element("humidity").textContent = fixed(humidity);
  element("vpd").textContent = fixed(vpd(temperature, humidity), 2);
  element("waterTemperature").textContent = fixed(water);
  element("sensorAge").textContent = relative(measured);

  const telemetry = data.light?.telemetry;
  const lightState = telemetry?.power_state || "unknown";
  element("lightState").dataset.state = lightState;
  element("lightState").textContent = lightState === "on" ? "켜짐" : lightState === "off" ? "꺼짐" : "확인 불가";
  element("lightPower").textContent = fixed(finite(telemetry?.power_w));
  element("lightObserved").textContent = telemetry?.observed_at ? `${relative(telemetry.observed_at)} 확인` : "상태 기록 없음";

  const schedule = data.light?.schedule || {};
  element("scheduleEnabled").checked = Boolean(schedule.enabled);
  element("scheduleOn").value = schedule.on || "07:00";
  element("scheduleOff").value = schedule.off || "21:00";
  element("scheduleNext").textContent = schedule.next_transition ? `다음 전환 ${jst(schedule.next_transition)}` : "스케줄 정지";
  element("scheduleOverride").textContent = schedule.override_until
    ? `수동 ${schedule.override_state === "on" ? "켜짐" : "꺼짐"} · ${jst(schedule.override_until)}까지`
    : "";

  const ac = data.air_conditioner?.last_command;
  element("acLastCommand").textContent = commandLabel(ac);
  element("acLastCommandTime").textContent = ac
    ? `${jst(ac.requested_at)} · ${ac.status === "failed" ? "실패" : "전송 완료"} · 실제 상태 미확인`
    : "에어컨은 실제 상태를 회신하지 않습니다.";
  element("adminIdentity").textContent = data.admin?.email || "Cloudflare Access";
  renderLog(data.commands);
}

async function refresh(silent = false) {
  if (!silent) notice("관리 상태를 새로 불러오는 중입니다.");
  try {
    render(await api("/admin/api/status"));
    if (!silent) notice("최신 상태를 불러왔습니다.", "success");
  } catch (error) {
    notice(`상태 조회 실패: ${error.message}`, "error");
  }
}

async function action(message, work) {
  if (state.busy) return;
  setBusy(true);
  notice(message);
  try {
    await work();
    await refresh(true);
    notice("요청을 처리했습니다.", "success");
  } catch (error) {
    notice(`요청 실패: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

document.querySelectorAll("[data-light-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const power = button.dataset.lightCommand;
    if (!confirm(`조명을 지금 ${power === "on" ? "켜겠습니까" : "끄겠습니까"}?`)) return;
    action("SwitchBot 조명 명령을 전송 중입니다.", () => api("/admin/api/light/command", {
      method: "POST", body: JSON.stringify({ power })
    }));
  });
});

element("scheduleForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = {
    enabled: element("scheduleEnabled").checked,
    on: element("scheduleOn").value,
    off: element("scheduleOff").value
  };
  if (body.on === body.off) return notice("켜기와 끄기 시각은 달라야 합니다.", "error");
  action("조명 스케줄을 저장 중입니다.", () => api("/admin/api/light/schedule", {
    method: "PUT", body: JSON.stringify(body)
  }));
});

element("scheduleDefault").addEventListener("click", () => {
  element("scheduleOn").value = "07:00";
  element("scheduleOff").value = "21:00";
  element("scheduleEnabled").checked = true;
});

element("acForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = {
    power: "on",
    mode: Number(element("acMode").value),
    temperature: Number(element("acTemperature").value),
    fan: Number(element("acFan").value)
  };
  if (!confirm("선택한 설정을 에어컨으로 전송하겠습니까?")) return;
  action("에어컨 운전 명령을 전송 중입니다.", () => api("/admin/api/ac/command", {
    method: "POST", body: JSON.stringify(body)
  }));
});

element("acOff").addEventListener("click", () => {
  if (!confirm("에어컨 운전을 정지하겠습니까?")) return;
  action("에어컨 정지 명령을 전송 중입니다.", () => api("/admin/api/ac/command", {
    method: "POST", body: JSON.stringify({ power: "off" })
  }));
});

element("refresh").addEventListener("click", () => refresh());
refresh();
setInterval(() => { if (!document.hidden && !state.busy) refresh(true); }, 60_000);
