const state = { catalog: null };
const element = (id) => document.getElementById(id);
const DATA_API_BASE = String(globalThis.HYDROPONICS_CONFIG?.dataApiBaseUrl || "").replace(/\/$/, "");

function apiUrl(path) {
  return `${DATA_API_BASE}${path}`;
}

function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일`;
}

function formatUpdated(value) {
  return value ? new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Tokyo", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value)) : "";
}

function liquidLabel(value) {
  return { water: "물", prepared_solution: "조제 양액", concentrate: "농축 양액", other: "기타" }[value] || "양액";
}

function notice(message, kind = "") {
  element("notice").textContent = message;
  element("notice").className = `notice ${kind}`.trim();
}

async function api(path) {
  const response = await fetch(apiUrl(path), { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

function refreshDays() {
  const selected = element("filterDay").value;
  const year = Number(element("filterYear").value);
  const month = Number(element("filterMonth").value);
  const count = new Date(year, month, 0).getDate();
  element("filterDay").replaceChildren(option("", "전체"));
  for (let day = 1; day <= count; day += 1) element("filterDay").append(option(day, `${day}일`));
  if (Number(selected) <= count) element("filterDay").value = selected;
}

function initializeFilters() {
  const [currentYear, currentMonth] = todayJst().split("-").map(Number);
  const periods = state.catalog.periods || [];
  const fallback = periods[0] || { year: currentYear, month: String(currentMonth).padStart(2, "0") };
  const years = new Set([currentYear, ...periods.map((item) => Number(item.year))]);
  [...years].sort((a, b) => b - a).forEach((year) => element("filterYear").append(option(year, `${year}년`)));
  for (let month = 1; month <= 12; month += 1) element("filterMonth").append(option(month, `${month}월`));
  element("filterYear").value = String(fallback.year);
  element("filterMonth").value = String(Number(fallback.month));
  state.catalog.crops.forEach((crop) => element("filterCrop").append(option(crop.id, crop.common_name)));
  state.catalog.tags.forEach((tag) => element("filterTag").append(option(tag.id, tag.name)));
  refreshDays();
}

function valueBadge(text) {
  const item = document.createElement("span");
  item.textContent = text;
  return item;
}

function addMeasurements(container, measurements) {
  const ph = measurements.solution_ph;
  const ec = measurements.electrical_conductivity;
  const topup = measurements.solution_added_volume;
  if (ph) container.append(valueBadge(`pH ${ph.value}`));
  if (ec) container.append(valueBadge(`EC ${ec.value} ${ec.unit}`));
  if (topup) container.append(valueBadge(`${liquidLabel(topup.qualifier)} ${topup.value} ${topup.unit} 보충`));
}

function renderList(entries) {
  const container = element("journalList");
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "선택한 기간에 공개된 기록이 없습니다.";
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "journal-card";
    card.addEventListener("click", () => openEntry(entry.id));
    if (entry.photo) {
      const image = document.createElement("img");
      image.loading = "lazy";
      image.alt = `${formatDate(entry.journal_date)} 대표 사진`;
      image.src = apiUrl(entry.photo.thumbnail_url);
      card.append(image);
    }
    const content = document.createElement("div");
    const date = document.createElement("strong");
    date.textContent = formatDate(entry.journal_date);
    const crops = document.createElement("div");
    crops.className = "chips";
    entry.crop_names.forEach((name) => crops.append(valueBadge(name)));
    const note = document.createElement("p");
    note.textContent = entry.common_note || (entry.section_count ? "작물별 기록이 있습니다." : "수동 측정값 기록");
    const values = document.createElement("div");
    values.className = "values compact";
    if (entry.solution_ph !== null) values.append(valueBadge(`pH ${entry.solution_ph}`));
    if (entry.electrical_conductivity !== null) values.append(valueBadge(`EC ${entry.electrical_conductivity} mS/cm`));
    if (entry.solution_added_volume !== null) values.append(valueBadge(`${liquidLabel(entry.solution_added_liquid_type)} ${entry.solution_added_volume} L 보충`));
    content.append(date, crops, note, values);
    card.append(content);
    container.append(card);
  }
}

async function loadList() {
  const parameters = new URLSearchParams({ year: element("filterYear").value, month: element("filterMonth").value });
  if (element("filterDay").value) parameters.set("day", element("filterDay").value);
  if (element("filterCrop").value) parameters.set("crop_id", element("filterCrop").value);
  if (element("filterTag").value) parameters.set("tag_id", element("filterTag").value);
  notice("재배일지를 불러오는 중입니다.");
  try {
    const result = await api(`/api/journal?${parameters}`);
    renderList(result.entries);
    notice(`공개 기록 ${result.entries.length}건`, "success");
  } catch (error) {
    notice(`조회 실패: ${error.message}`, "error");
  }
}

function renderDetail(entry) {
  element("detailDate").textContent = formatDate(entry.journal_date);
  element("detailUpdatedAt").textContent = `최근 수정 ${formatUpdated(entry.updated_at)}`;
  element("detailCommonNote").textContent = entry.common_note || "공통 관리 기록이 없습니다.";
  const values = element("detailValues");
  values.replaceChildren();
  addMeasurements(values, entry.measurements);
  const cover = element("detailPhoto");
  cover.hidden = !entry.photo;
  if (entry.photo) element("detailPhotoImage").src = apiUrl(entry.photo.url);
  const crops = element("detailCropSections");
  crops.replaceChildren();
  for (const section of entry.sections) {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = section.title ? `${section.crop_name} · ${section.title}` : section.crop_name;
    const tags = document.createElement("div");
    tags.className = "chips";
    section.tags.forEach((tag) => tags.append(valueBadge(tag.name)));
    const body = document.createElement("p");
    body.className = "record-body";
    body.textContent = section.body;
    article.append(title, tags, body);
    if (section.photos.length) {
      const gallery = document.createElement("div");
      gallery.className = "gallery";
      for (const photo of section.photos) {
        const link = document.createElement("a");
        link.href = apiUrl(photo.url);
        link.target = "_blank";
        link.rel = "noreferrer";
        const image = document.createElement("img");
        image.loading = "lazy";
        image.alt = `${section.crop_name} 기록 사진`;
        image.src = apiUrl(photo.thumbnail_url);
        link.append(image);
        gallery.append(link);
      }
      article.append(gallery);
    }
    crops.append(article);
  }
  element("detailEmptyCrops").hidden = entry.sections.length > 0;
}

async function openEntry(id) {
  notice("기록을 불러오는 중입니다.");
  try {
    const result = await api(`/api/journal/${id}`);
    renderDetail(result.entry);
    element("listView").hidden = true;
    element("detailView").hidden = false;
    notice("공개 재배 기록", "success");
    history.replaceState({ journalId: id }, "", `#${id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    notice(`기록 조회 실패: ${error.message}`, "error");
  }
}

function showList() {
  element("detailView").hidden = true;
  element("listView").hidden = false;
  history.replaceState({}, "", location.pathname);
}

async function start() {
  try {
    state.catalog = await api("/api/journal/meta");
    initializeFilters();
    document.querySelectorAll(".toolbar select").forEach((select) => select.addEventListener("change", () => {
      if (select.id === "filterYear" || select.id === "filterMonth") refreshDays();
      loadList();
    }));
    element("backToList").addEventListener("click", showList);
    await loadList();
    if (/^#[a-f0-9-]{36}$/.test(location.hash)) await openEntry(location.hash.slice(1));
  } catch (error) {
    notice(`초기화 실패: ${error.message}`, "error");
  }
}

start();
