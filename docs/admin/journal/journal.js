const state = {
  catalog: null,
  current: null,
  busy: false,
  pendingPhoto: null,
  removePhoto: false,
  previewUrl: null
};
const element = (id) => document.getElementById(id);

function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function notice(message, kind = "") {
  element("notice").textContent = message;
  element("notice").className = `notice ${kind}`.trim();
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll("button,input,select,textarea").forEach((control) => {
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

async function photoApi(path, init) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
  return body;
}

function photoUrl(url, updatedAt) {
  if (!url) return "";
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${encodeURIComponent(updatedAt || "1")}`;
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function initializeFilters() {
  const [currentYear, currentMonth] = todayJst().split("-").map(Number);
  const years = new Set([currentYear, ...(state.catalog.periods || []).map((item) => Number(item.year))]);
  [...years].sort((a, b) => b - a).forEach((year) => element("filterYear").append(option(year, `${year}년`)));
  for (let month = 1; month <= 12; month += 1) element("filterMonth").append(option(month, `${month}월`));
  element("filterYear").value = String(currentYear);
  element("filterMonth").value = String(currentMonth);
  state.catalog.crops.forEach((crop) => element("filterCrop").append(option(crop.id, crop.common_name)));
  state.catalog.tags.forEach((tag) => element("filterTag").append(option(tag.id, tag.name)));
  refreshDayOptions();
}

function refreshDayOptions() {
  const selected = element("filterDay").value;
  const year = Number(element("filterYear").value);
  const month = Number(element("filterMonth").value);
  const count = new Date(year, month, 0).getDate();
  element("filterDay").replaceChildren(option("", "전체"));
  for (let day = 1; day <= count; day += 1) element("filterDay").append(option(day, `${day}일`));
  if (Number(selected) <= count) element("filterDay").value = selected;
}

function liquidLabel(value) {
  return { water: "물", prepared_solution: "조제 양액", concentrate: "농축 양액", other: "기타" }[value] || "";
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일`;
}

function formatUpdatedAt(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function valueBadge(text) {
  const value = document.createElement("span");
  value.className = "card-value";
  value.textContent = text;
  return value;
}

function summaryText(entry) {
  const note = (entry.common_note || "").replace(/\s+/g, " ").trim();
  if (note) return note.length > 100 ? `${note.slice(0, 100)}…` : note;
  if (entry.section_count) return `${entry.crop_names.join(" · ")} 작물 기록 ${entry.section_count}건`;
  return "수동 측정값 기록";
}

function renderList(entries) {
  const container = element("journalList");
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "선택한 기간에 작성된 일지가 없습니다.";
    container.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "journal-card";
    card.addEventListener("click", () => openEntry(entry.id));
    const content = document.createElement("div");
    content.className = "journal-card-content";
    const top = document.createElement("div");
    top.className = "card-top";
    const date = document.createElement("span");
    date.className = "card-date";
    date.textContent = formatDate(entry.journal_date);
    const visibility = document.createElement("span");
    visibility.className = `visibility ${entry.visibility}`;
    visibility.textContent = entry.visibility === "public" ? "공개 예정" : "비공개";
    top.append(date, visibility);
    const crops = document.createElement("div");
    crops.className = "crop-chips";
    entry.crop_names.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = name;
      crops.append(chip);
    });
    const summary = document.createElement("p");
    summary.className = "card-summary";
    summary.textContent = summaryText(entry);
    const values = document.createElement("div");
    values.className = "card-values";
    const appendValue = (text) => values.append(valueBadge(text));
    if (entry.solution_ph !== null) appendValue(`pH ${entry.solution_ph}`);
    if (entry.electrical_conductivity !== null) appendValue(`EC ${entry.electrical_conductivity} mS/cm`);
    if (entry.solution_added_volume !== null) appendValue(`${liquidLabel(entry.solution_added_liquid_type)} ${entry.solution_added_volume} L 보충`);
    content.append(top, crops, summary, values);
    if (entry.photo) {
      card.classList.add("has-photo");
      const thumbnail = document.createElement("img");
      thumbnail.className = "journal-thumbnail";
      thumbnail.loading = "lazy";
      thumbnail.alt = `${formatDate(entry.journal_date)} 재배 사진`;
      thumbnail.src = photoUrl(entry.photo.thumbnail_url, entry.photo.updated_at);
      card.append(thumbnail, content);
    } else {
      card.append(content);
    }
    container.append(card);
  });
}

async function loadList() {
  notice("재배일지를 불러오는 중입니다.");
  const parameters = new URLSearchParams({
    year: element("filterYear").value,
    month: element("filterMonth").value
  });
  if (element("filterDay").value) parameters.set("day", element("filterDay").value);
  if (element("filterCrop").value) parameters.set("crop_id", element("filterCrop").value);
  if (element("filterTag").value) parameters.set("tag_id", element("filterTag").value);
  try {
    const result = await api(`/admin/api/journal?${parameters}`);
    renderList(result.entries);
    notice(`${result.entries.length}개의 일지를 표시했습니다.`, "success");
  } catch (error) {
    notice(`일지 조회 실패: ${error.message}`, "error");
  }
}

function sectionElement(section = {}) {
  const fragment = element("sectionTemplate").content.cloneNode(true);
  const article = fragment.querySelector(".crop-section");
  const cropSelect = article.querySelector(".section-crop");
  state.catalog.crops.forEach((crop) => cropSelect.append(option(crop.id, crop.common_name)));
  cropSelect.value = section.crop_id || state.catalog.crops.find((crop) => !usedCropIds().has(crop.id))?.id || state.catalog.crops[0]?.id || "";
  article.querySelector(".section-title").value = section.title || "";
  article.querySelector(".section-body").value = section.body || "";
  const selectedTags = new Set((section.tags || []).map((tag) => tag.id));
  const tagContainer = article.querySelector(".tag-options");
  state.catalog.tags.forEach((tag) => {
    const label = document.createElement("label");
    label.className = "tag-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = tag.id;
    input.checked = selectedTags.has(tag.id);
    const name = document.createElement("span");
    name.textContent = tag.name;
    label.append(input, name);
    tagContainer.append(label);
  });
  article.querySelector(".remove-section").addEventListener("click", () => {
    article.remove();
    updateEmptySections();
    refreshCropChoices();
  });
  cropSelect.addEventListener("change", refreshCropChoices);
  return fragment;
}

function usedCropIds() {
  return new Set([...document.querySelectorAll(".section-crop")].map((select) => select.value).filter(Boolean));
}

function refreshCropChoices() {
  const selects = [...document.querySelectorAll(".section-crop")];
  const selected = new Set(selects.map((select) => select.value).filter(Boolean));
  selects.forEach((select) => {
    [...select.options].forEach((item) => {
      item.disabled = item.value !== select.value && selected.has(item.value);
    });
  });
}

function addSection(section) {
  if (!section && usedCropIds().size >= state.catalog.crops.length) {
    return notice("현재 등록된 모든 작물의 기록란이 이미 있습니다.", "error");
  }
  element("cropSections").append(sectionElement(section));
  updateEmptySections();
  refreshCropChoices();
}

function updateEmptySections() {
  element("emptySections").hidden = element("cropSections").children.length > 0;
}

function metricValue(entry, name) {
  return entry?.measurements?.[name]?.value ?? "";
}

function renderDetail(entry) {
  state.current = entry;
  element("detailDate").textContent = formatDate(entry.journal_date);
  const visibility = element("detailVisibility");
  visibility.className = `visibility ${entry.visibility}`;
  visibility.textContent = entry.visibility === "public" ? "공개 예정" : "비공개";
  element("detailUpdatedAt").textContent = `수정 ${formatUpdatedAt(entry.updated_at)}`;

  const photo = element("detailPhoto");
  const image = element("detailPhotoImage");
  photo.hidden = !entry.photo;
  if (entry.photo) {
    image.src = photoUrl(entry.photo.url, entry.photo.updated_at);
  } else {
    image.removeAttribute("src");
  }

  const commonNote = element("detailCommonNote");
  commonNote.textContent = entry.common_note || "공통 관리 기록이 없습니다.";
  commonNote.classList.toggle("muted", !entry.common_note);

  const values = element("detailValues");
  values.replaceChildren();
  const ph = metricValue(entry, "solution_ph");
  const ec = metricValue(entry, "electrical_conductivity");
  const topUp = metricValue(entry, "solution_added_volume");
  if (ph !== "") values.append(valueBadge(`pH ${ph}`));
  if (ec !== "") values.append(valueBadge(`EC ${ec} mS/cm`));
  if (topUp !== "") {
    const type = entry.measurements.solution_added_volume.qualifier;
    values.append(valueBadge(`${liquidLabel(type)} ${topUp} L 보충`));
  }
  values.hidden = values.children.length === 0;

  const crops = element("detailCropSections");
  crops.replaceChildren();
  entry.sections.forEach((section) => {
    const article = document.createElement("article");
    article.className = "detail-crop";
    const head = document.createElement("div");
    head.className = "detail-crop-head";
    const heading = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = section.crop_name;
    heading.append(name);
    if (section.title) {
      const title = document.createElement("p");
      title.className = "detail-crop-title";
      title.textContent = section.title;
      heading.append(title);
    }
    head.append(heading);
    const body = document.createElement("p");
    body.className = "detail-crop-body";
    body.textContent = section.body;
    article.append(head, body);
    if (section.tags.length) {
      const tags = document.createElement("div");
      tags.className = "detail-tags";
      section.tags.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = tag.name;
        tags.append(chip);
      });
      article.append(tags);
    }
    crops.append(article);
  });
  element("detailEmptyCrops").hidden = entry.sections.length > 0;
}

function resetEditor(entry = null) {
  state.current = entry;
  element("editorTitle").textContent = entry ? formatDate(entry.journal_date) : "새 재배일지";
  element("journalDate").value = entry?.journal_date || todayJst();
  element("journalVisibility").value = entry?.visibility || "private";
  element("commonNote").value = entry?.common_note || "";
  element("solutionPh").value = metricValue(entry, "solution_ph");
  element("solutionEc").value = metricValue(entry, "electrical_conductivity");
  element("topUpVolume").value = metricValue(entry, "solution_added_volume");
  element("topUpType").value = entry?.measurements?.solution_added_volume?.qualifier || "prepared_solution";
  element("cropSections").replaceChildren();
  (entry?.sections || []).forEach(addSection);
  updateEmptySections();
  element("deleteEntry").hidden = !entry;
  resetPhotoEditor(entry);
}

function revokePreviewUrl() {
  if (!state.previewUrl) return;
  URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
}

function showPhotoPreview(source = "") {
  const preview = element("photoPreview");
  preview.hidden = !source;
  element("photoEmpty").hidden = Boolean(source);
  if (source) preview.src = source;
  else preview.removeAttribute("src");
}

function resetPhotoEditor(entry) {
  revokePreviewUrl();
  state.pendingPhoto = null;
  state.removePhoto = false;
  showPhotoPreview(entry?.photo ? photoUrl(entry.photo.url, entry.photo.updated_at) : "");
  element("removePhoto").hidden = !entry?.photo;
  element("cameraPhotoInput").value = "";
  element("galleryPhotoInput").value = "";
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const source = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(source);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(source);
      reject(new Error("이 사진 형식은 브라우저에서 읽을 수 없습니다."));
    };
    image.src = source;
  });
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("사진 압축에 실패했습니다.")),
      "image/jpeg",
      quality
    );
  });
}

async function resizedJpeg(image, maximumDimension, quality) {
  const scale = Math.min(1, maximumDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return { blob: await canvasBlob(canvas, quality), width, height };
}

async function preparePhoto(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("이미지 파일을 선택해 주세요.");
  if (file.size > 30_000_000) throw new Error("원본 사진은 30MB 이하만 선택할 수 있습니다.");
  const image = await loadImage(file);
  const full = await resizedJpeg(image, 1600, 0.82);
  const thumbnail = await resizedJpeg(image, 420, 0.74);
  if (full.blob.size > 2_000_000) throw new Error("압축된 사진이 2MB를 초과했습니다.");
  return {
    photo: full.blob,
    thumbnail: thumbnail.blob,
    width: full.width,
    height: full.height
  };
}

async function choosePhoto(file) {
  if (!file || state.busy) return;
  setBusy(true);
  notice("사진을 축소하고 압축하는 중입니다.");
  try {
    const prepared = await preparePhoto(file);
    revokePreviewUrl();
    state.pendingPhoto = prepared;
    state.removePhoto = false;
    state.previewUrl = URL.createObjectURL(prepared.photo);
    showPhotoPreview(state.previewUrl);
    element("removePhoto").hidden = false;
    notice(`사진을 준비했습니다. ${(prepared.photo.size / 1024).toFixed(0)}KB`, "success");
  } catch (error) {
    notice(`사진 준비 실패: ${error.message}`, "error");
  } finally {
    element("cameraPhotoInput").value = "";
    element("galleryPhotoInput").value = "";
    setBusy(false);
  }
}

async function savePhotoChange(entry) {
  if (state.pendingPhoto) {
    const form = new FormData();
    form.set("photo", state.pendingPhoto.photo, "journal-photo.jpg");
    form.set("thumbnail", state.pendingPhoto.thumbnail, "journal-thumbnail.jpg");
    form.set("revision", String(entry.revision));
    form.set("width", String(state.pendingPhoto.width));
    form.set("height", String(state.pendingPhoto.height));
    return (await photoApi(`/admin/api/journal/${entry.id}/photo`, {
      method: "PUT",
      body: form
    })).entry;
  }
  if (state.removePhoto && entry.photo) {
    return (await photoApi(`/admin/api/journal/${entry.id}/photo`, {
      method: "DELETE",
      headers: { "X-Journal-Revision": String(entry.revision) }
    })).entry;
  }
  return entry;
}

function showEditor() {
  element("listView").hidden = true;
  element("detailView").hidden = true;
  element("editorView").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showDetail() {
  element("listView").hidden = true;
  element("editorView").hidden = true;
  element("detailView").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showList() {
  revokePreviewUrl();
  element("editorView").hidden = true;
  element("detailView").hidden = true;
  element("listView").hidden = false;
  state.current = null;
  loadList();
}

async function openEntry(id) {
  notice("일지 상세 내용을 불러오는 중입니다.");
  try {
    const result = await api(`/admin/api/journal/${id}`);
    renderDetail(result.entry);
    showDetail();
    notice("일지를 불러왔습니다.", "success");
  } catch (error) {
    notice(`일지 조회 실패: ${error.message}`, "error");
  }
}

function numberOrNull(id) {
  const value = element(id).value.trim();
  return value === "" ? null : Number(value);
}

function formPayload() {
  const sections = [...document.querySelectorAll(".crop-section")].map((article) => ({
    crop_id: article.querySelector(".section-crop").value,
    title: article.querySelector(".section-title").value,
    body: article.querySelector(".section-body").value,
    tag_ids: [...article.querySelectorAll(".tag-check input:checked")].map((input) => input.value)
  }));
  return {
    journal_date: element("journalDate").value,
    common_note: element("commonNote").value,
    visibility: element("journalVisibility").value,
    revision: state.current?.revision,
    measurements: {
      solution_ph: numberOrNull("solutionPh"),
      electrical_conductivity: numberOrNull("solutionEc"),
      solution_added_volume: numberOrNull("topUpVolume"),
      solution_added_liquid_type: element("topUpVolume").value.trim() ? element("topUpType").value : null
    },
    sections
  };
}

element("journalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  setBusy(true);
  notice("재배일지를 저장하는 중입니다.");
  try {
    const method = state.current ? "PUT" : "POST";
    const path = state.current ? `/admin/api/journal/${state.current.id}` : "/admin/api/journal";
    const result = await api(path, { method, body: JSON.stringify(formPayload()) });
    state.current = result.entry;
    let entry = result.entry;
    try {
      entry = await savePhotoChange(entry);
    } catch (photoError) {
      revokePreviewUrl();
      state.pendingPhoto = null;
      state.removePhoto = false;
      renderDetail(entry);
      showDetail();
      notice(`일지는 저장했지만 사진 저장에 실패했습니다: ${photoError.message}`, "error");
      return;
    }
    revokePreviewUrl();
    state.pendingPhoto = null;
    state.removePhoto = false;
    renderDetail(entry);
    showDetail();
    notice("재배일지를 저장했습니다.", "success");
  } catch (error) {
    notice(`저장 실패: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
});

element("deleteEntry").addEventListener("click", async () => {
  if (!state.current || state.busy || !confirm(`${state.current.journal_date} 일지를 삭제하시겠습니까?`)) return;
  setBusy(true);
  try {
    await api(`/admin/api/journal/${state.current.id}`, { method: "DELETE" });
    notice("재배일지를 삭제했습니다.", "success");
    showList();
  } catch (error) {
    notice(`삭제 실패: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
});

element("newEntry").addEventListener("click", () => { resetEditor(); showEditor(); notice("새 일지를 작성합니다."); });
element("detailBackToList").addEventListener("click", showList);
element("editEntry").addEventListener("click", () => { resetEditor(state.current); showEditor(); notice("일지를 수정합니다."); });
element("backToList").addEventListener("click", () => {
  if (state.current) {
    resetPhotoEditor(state.current);
    renderDetail(state.current);
    showDetail();
    notice("수정을 취소하고 일지로 돌아왔습니다.");
  } else {
    showList();
  }
});
element("addSection").addEventListener("click", () => addSection());
element("capturePhoto").addEventListener("click", () => element("cameraPhotoInput").click());
element("selectPhoto").addEventListener("click", () => element("galleryPhotoInput").click());
element("cameraPhotoInput").addEventListener("change", (event) => choosePhoto(event.target.files?.[0]));
element("galleryPhotoInput").addEventListener("change", (event) => choosePhoto(event.target.files?.[0]));
element("removePhoto").addEventListener("click", () => {
  revokePreviewUrl();
  state.pendingPhoto = null;
  state.removePhoto = Boolean(state.current?.photo);
  showPhotoPreview();
  element("removePhoto").hidden = true;
  notice(state.removePhoto ? "저장하면 기존 사진이 제거됩니다." : "선택한 사진을 제거했습니다.");
});
["filterYear", "filterMonth", "filterDay", "filterCrop", "filterTag"].forEach((id) => {
  element(id).addEventListener("change", () => {
    if (id === "filterYear" || id === "filterMonth") refreshDayOptions();
    loadList();
  });
});

async function initialize() {
  try {
    state.catalog = await api("/admin/api/journal/meta");
    initializeFilters();
    await loadList();
  } catch (error) {
    notice(`재배일지 초기화 실패: ${error.message}`, "error");
  }
}

initialize();
