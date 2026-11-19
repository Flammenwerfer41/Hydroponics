import { SERIES, BATTERY_PERCENT, segments, extent, loadHistory } from "./history-data.mjs?v=20261117-policy";

const dateTime = time => new Date(time).toLocaleString("ko-KR", { timeZone: "Asia/Tokyo", month: "numeric",
  day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const NS = "http://www.w3.org/2000/svg";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function svgElement(tag, attrs, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawChart(host, data, spec) {
  host.replaceChildren();
  const points = data.rows.filter(row => Number.isFinite(row.values[spec.key]));
  const values = points.map(row => row.values[spec.key]);
  const heading = element("h3", `${spec.title} · ${spec.unit}`);
  host.append(heading);
  if (!points.length) { host.append(element("p", "이 항목의 유효한 측정값이 없습니다.", "hint")); return () => {}; }
  const format = value => `${value.toFixed(spec.digits)} ${spec.unit}`;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  host.append(element("p", `최저 ${format(Math.min(...values))} · 최고 ${format(Math.max(...values))} · 표본 평균 ${format(mean)}`, "chart-stats"));
  const [low, high] = extent(values, spec);
  let width = 0;
  const height = 250, left = 68, right = 22, top = 18, bottom = 42;
  const x = time => left + (time - data.from) / (data.to - data.from) * (width - left - right);
  const y = value => top + (high - value) / (high - low) * (height - top - bottom);
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", tabindex: "0",
    "aria-label": `${spec.title} 변화. 좌우 방향키로 관측값을 확인할 수 있습니다.` });
  function drawGeometry() {
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren(svgElement("title", {}, `${spec.title} · ${dateTime(data.from)} ~ ${dateTime(data.to)} JST`));
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i / 4, py = y(value);
    svg.append(svgElement("line", { x1: left, x2: width - right, y1: py, y2: py, stroke: "#e1eae5" }));
    svg.append(svgElement("text", { x: left - 9, y: py + 4, "text-anchor": "end", class: "axis-label" }, value.toFixed(spec.digits)));
  }
  const ticks = width < 500 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const time = data.from + (data.to - data.from) * i / ticks;
    const date = new Date(time);
    const label = data.to - data.from <= 86400000 ? date.toLocaleTimeString("ko-KR", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }) :
      `${date.toLocaleDateString("ko-KR", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" })} ${date.toLocaleTimeString("ko-KR", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false })}`;
    svg.append(svgElement("text", { x: x(time), y: height - 13, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle", class: "axis-label" }, label));
  }
  for (const group of segments(data.rows, spec.key)) {
    if (group.length === 1) svg.append(svgElement("circle", { cx: x(group[0].time), cy: y(group[0].value), r: 3, fill: spec.color }));
    else svg.append(svgElement("path", { d: group.map((point, i) => `${i ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`).join(" "),
      fill: "none", stroke: spec.color, "stroke-width": 2, "vector-effect": "non-scaling-stroke" }));
  }
  }
  const marker = svgElement("circle", { r: 4, fill: spec.color, stroke: "white", "stroke-width": 2 });
  svg.append(marker);
  const readout = element("p", "", "chart-readout");
  let selected = points.length - 1;
  function select(index) {
    selected = Math.max(0, Math.min(points.length - 1, index));
    const point = points[selected];
    marker.setAttribute("cx", x(point.time)); marker.setAttribute("cy", y(point.values[spec.key]));
    readout.textContent = `${dateTime(point.time)} JST · ${format(point.values[spec.key])}`;
  }
  const pointAt = event => {
    const box = svg.getBoundingClientRect();
    const target = data.from + ((event.clientX - box.left) / box.width * width - left) / (width - left - right) * (data.to - data.from);
    let nearest = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].time - target) < Math.abs(points[nearest].time - target)) nearest = i;
    select(nearest);
  };
  svg.addEventListener("pointermove", pointAt);
  svg.addEventListener("pointerdown", pointAt);
  svg.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    select(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : selected + (event.key === "ArrowLeft" ? -1 : 1));
  });
  host.append(svg, readout);
  function resize() {
    const nextWidth = Math.max(340, Math.round(host.clientWidth || 760));
    if (nextWidth === width) return; // Browser toolbar/keyboard height changes must not rebuild charts.
    width = nextWidth;
    drawGeometry();
    svg.append(marker);
    select(selected); // Keep the selected reading and the same focusable SVG element.
  }
  resize();
  return resize;
}

export function renderHistory(container, data) {
  const plots = [];
  container.replaceChildren();
  container.append(element("p", "시각은 JST입니다. 결측값 및 보고된 관측 주기 + 5분을 초과하는 구간은 선을 연결하지 않습니다. 주기 미보고 기록은 20분 기준입니다. 그래프를 터치하거나 가리키면 값을 확인할 수 있습니다.", "hint"));
  for (const spec of SERIES) {
    const card = element("article", undefined, "history-chart"), plot = element("div");
    let resizePlot;
    if (spec.key === "battery_voltage") {
      const label = element("label", "배터리 표시 "), selector = element("select");
      selector.setAttribute("aria-label", "배터리 그래프 표시 방식");
      for (const [value, text] of [["voltage", "전압 (V)"], ["percent", "추정 잔량 (%)"]]) {
        const option = element("option", text); option.value = value; selector.append(option);
      }
      label.append(selector); card.append(label);
      selector.addEventListener("change", () => { resizePlot = drawChart(plot, data, selector.value === "percent" ? BATTERY_PERCENT : spec); });
      card.append(element("p", "잔량은 삼성 35E의 상온·0.2C 방전곡선 기반 추정치입니다. 과거 전압에도 같은 환산표를 적용하며 실제 충전량은 아닙니다. 전압 축은 자동 확대됩니다.", "hint"));
    }
    card.append(plot); container.append(card); resizePlot = drawChart(plot, data, spec);
    plots.push(() => resizePlot());
  }
  return () => plots.forEach(resize => resize());
}

export function setupHistory(base) {
  const button = document.querySelector("#history-load"), period = document.querySelector("#history-period");
  const status = document.querySelector("#history-status"), charts = document.querySelector("#history-charts");
  let busy = false, resizeCharts = null, resizeFrame;
  const scheduleResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!charts.hidden) resizeCharts?.();
    });
  };
  // Observe the actual chart container rather than the mobile visual viewport.
  // Each plot additionally ignores unchanged widths and updates its SVG in place.
  if (typeof ResizeObserver === "function") new ResizeObserver(scheduleResize).observe(charts);
  else window.addEventListener("resize", scheduleResize);
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true; button.disabled = true; period.disabled = true;
    resizeCharts = null; charts.hidden = true; charts.replaceChildren();
    status.textContent = "기록을 불러오는 중입니다…";
    try {
      const data = await loadHistory(base, Number(period.value));
      if (!data.rows.length) { status.textContent = "선택한 기간에 기상대 기록이 없습니다."; return; }
      charts.hidden = false; resizeCharts = renderHistory(charts, data);
      status.textContent = `${dateTime(data.from)} ~ ${dateTime(data.to)} JST · 기록 ${data.rows.length}개 · 최신 관측 ${dateTime(data.rows.at(-1).time)} JST`;
      button.textContent = "그래프 다시 불러오기";
    } catch (error) {
      status.textContent = `기록 조회 실패: ${error.message} 자동 재시도하지 않습니다. 잠시 후 다시 눌러주세요.`;
    } finally { busy = false; button.disabled = false; period.disabled = false; }
  });
}
