const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function todayJst(now = Date.now()) {
  return new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function createOption(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

export function formatJournalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일`;
}

export function formatJournalTimestamp(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function liquidLabel(value, fallback = "") {
  return {
    water: "물",
    prepared_solution: "조제 양액",
    concentrate: "농축 양액",
    other: "기타"
  }[value] || fallback;
}

export function createValueBadge(text, className = "") {
  const item = document.createElement("span");
  if (className) item.className = className;
  item.textContent = text;
  return item;
}

export function refreshJournalDays(yearSelect, monthSelect, daySelect, allLabel = "전체") {
  const selected = daySelect.value;
  const year = Number(yearSelect.value);
  const month = Number(monthSelect.value);
  const count = new Date(year, month, 0).getDate();
  daySelect.replaceChildren(createOption("", allLabel));
  for (let day = 1; day <= count; day += 1) {
    daySelect.append(createOption(day, `${day}일`));
  }
  if (Number(selected) <= count) daySelect.value = selected;
}
