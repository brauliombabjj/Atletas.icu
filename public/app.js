const periodSelect = document.querySelector("#period-select");
const retryButton = document.querySelector("#retry-button");
const notice = document.querySelector("#notice");
const list = document.querySelector("#activity-list");
const numberFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });
const fullDateFormat = new Intl.DateTimeFormat("pt-BR", {
  weekday: "short",
  day: "2-digit",
  month: "short",
});

let requestController;

function readNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== undefined && Number.isFinite(number)) return number;
  }
  return 0;
}

function activityDate(activity) {
  const value = activity.start_date_local || activity.start_date || activity.start_time;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function movingTime(activity) {
  return readNumber(activity.moving_time, activity.elapsed_time, activity.duration);
}

function distance(activity) {
  return readNumber(activity.distance, activity.distance_m);
}

function elevation(activity) {
  return readNumber(activity.total_elevation_gain, activity.elevation_gain, activity.elevation);
}

function formatDuration(seconds) {
  if (seconds < 60) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (!hours) return `${minutes} min`;
  return `${hours}h${String(minutes).padStart(2, "0")}`;
}

function activityType(activity) {
  return String(activity.type || activity.sport_type || activity.activity_type || "Treino")
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ");
}

function sportSymbol(type) {
  const normalized = type.toLocaleLowerCase("pt-BR");
  if (normalized.includes("run") || normalized.includes("corrida")) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="15.5" cy="4.5" r="2"/><path d="m13.5 8 3.5 2.5 3.5.5M13.5 8l-3 4 3 2.5-2 5M10.5 12l-4 1.5-2 4M13.5 14.5l4 2 2 4"/></svg>';
  }
  if (normalized.includes("ride") || normalized.includes("bike") || normalized.includes("cicl")) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="16.5" r="4"/><circle cx="18" cy="16.5" r="4"/><path d="m6 16.5 4-7h4l4 7m-8-7 3 7h5m-9-9h3"/></svg>';
  }
  if (normalized.includes("swim") || normalized.includes("nado")) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c2.2 0 2.2-2 4.5-2s2.3 2 4.5 2 2.3-2 4.5-2 2.3 2 4.5 2M3 19c2.2 0 2.2-2 4.5-2s2.3 2 4.5 2 2.3-2 4.5-2 2.3 2 4.5 2M9 8a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 17 6-6 4 4 8-9"/><path d="M15 6h6v6"/></svg>';
}

function setNotice(title, message, retry = false, kind = "info") {
  notice.hidden = false;
  notice.dataset.kind = kind;
  document.querySelector("#notice-title").textContent = title;
  document.querySelector("#notice-copy").textContent = message;
  retryButton.hidden = !retry;
}

function clearNotice() {
  notice.hidden = true;
  delete notice.dataset.kind;
}

function resetDashboard() {
  document.querySelector("#metric-distance").innerHTML = "—<small> km</small>";
  document.querySelector("#metric-time").innerHTML = "—<small> h</small>";
  document.querySelector("#metric-elevation").innerHTML = "—<small> m</small>";
  document.querySelector("#metric-count").innerHTML = "—<small> treinos</small>";
  document.querySelector("#average-distance").innerHTML = "—<small> km</small>";
  document.querySelector("#chart-summary").textContent = "";
  document.querySelector("#chart-total").textContent = "— km no total";
  document.querySelector("#volume-chart").replaceChildren();
  document.querySelector("#activity-count").textContent = "— atividades";
}

function setLoading() {
  list.setAttribute("aria-busy", "true");
  list.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Buscando suas atividades…</span></div>';
  resetDashboard();
  document.querySelector("#connection-label").textContent = "Sincronizando atividades";
  document.querySelector("#connection-label").previousElementSibling.className = "status-dot";
  clearNotice();
}

function setUnavailable(error) {
  list.setAttribute("aria-busy", "false");
  list.innerHTML = "";
  setNotice(
    error.code === "missing_configuration" ? "Conecte sua conta para começar" : "Não foi possível atualizar seus dados",
    error.message || "Tente novamente em instantes.",
    error.code !== "missing_configuration",
    error.code === "missing_configuration" ? "setup" : "error",
  );
  document.querySelector("#connection-label").textContent =
    error.code === "missing_configuration" ? "Configuração necessária" : "Falha na sincronização";
  document.querySelector("#connection-label").previousElementSibling.className = "status-dot offline";
  document.querySelector("#activity-count").textContent = "— atividades";
}

function setEmpty() {
  list.setAttribute("aria-busy", "false");
  list.innerHTML = '<div class="empty-state"><strong>Nenhuma atividade neste período</strong><span>Quando seus treinos estiverem registrados no Intervals.icu, eles aparecem por aqui.</span></div>';
}

function makeChart(activities, period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayCount = period === 7 ? 7 : Math.ceil(period / 7);
  const bucketSize = period === 7 ? 1 : 7;
  const labels = [];
  const values = Array(dayCount).fill(0);
  const start = new Date(today);
  start.setDate(start.getDate() - (period - 1));
  start.setHours(0, 0, 0, 0);

  for (let index = 0; index < dayCount; index += 1) {
    const bucketDate = new Date(start);
    bucketDate.setDate(bucketDate.getDate() + index * bucketSize);
    labels.push(period === 7
      ? new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(bucketDate).replace(".", "")
      : dateFormat.format(bucketDate).replace(".", ""));
  }

  for (const activity of activities) {
    const date = activityDate(activity);
    if (!date) continue;
    const elapsedDays = Math.floor((date - start) / 86_400_000);
    const bucket = Math.floor(elapsedDays / bucketSize);
    if (bucket >= 0 && bucket < values.length) values[bucket] += distance(activity) / 1000;
  }

  const chartWidth = 600;
  const chartHeight = 150;
  const left = 29;
  const right = 8;
  const top = 12;
  const bottom = 24;
  const plotHeight = chartHeight - top - bottom;
  const plotWidth = chartWidth - left - right;
  const max = Math.max(...values, 1);
  const scale = Math.ceil(max / 5) * 5 || 5;
  const slot = plotWidth / values.length;
  const barWidth = Math.min(28, slot * 0.45);
  const grid = [0, 0.5, 1].map((fraction) => {
    const y = top + plotHeight * fraction;
    return `<line class="grid-line" x1="${left}" y1="${y}" x2="${chartWidth - right}" y2="${y}"/><text class="axis-label" x="${left - 7}" y="${y + 3}" text-anchor="end">${decimalFormat.format(scale * (1 - fraction))}</text>`;
  }).join("");
  const bars = values.map((value, index) => {
    const height = value ? Math.max(2, (value / scale) * plotHeight) : 2;
    const x = left + slot * index + (slot - barWidth) / 2;
    const y = top + plotHeight - height;
    const accessibleValue = `${labels[index]}: ${decimalFormat.format(value)} quilômetros`;
    return `<g><title>${accessibleValue}</title><rect class="bar${value ? "" : " empty"}" x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="4"/><text class="axis-label" x="${left + slot * (index + 0.5)}" y="${chartHeight - 5}" text-anchor="middle">${labels[index]}</text></g>`;
  }).join("");

  document.querySelector("#volume-chart").innerHTML =
    `<svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Distância percorrida agrupada ${period === 7 ? "por dia" : "por semana"}, em quilômetros" aria-describedby="chart-summary">${grid}${bars}</svg>`;
  const total = values.reduce((sum, value) => sum + value, 0);
  document.querySelector("#chart-summary").textContent =
    `Total de ${decimalFormat.format(total)} quilômetros no período. ${values.filter(Boolean).length} intervalos com atividade.`;
  document.querySelector("#chart-total").textContent = `${decimalFormat.format(total)} km no total`;
}

function renderActivities(activities) {
  const sorted = [...activities].sort((left, right) =>
    (activityDate(right)?.getTime() ?? 0) - (activityDate(left)?.getTime() ?? 0),
  );
  list.setAttribute("aria-busy", "false");
  if (!sorted.length) {
    setEmpty();
    return;
  }

  const rows = sorted.slice(0, 12).map((activity) => {
    const date = activityDate(activity);
    const type = activityType(activity);
    const name = activity.name || activity.title || type;
    const meters = distance(activity);
    const distanceLabel = meters > 0 ? `${decimalFormat.format(meters / 1000)} km` : "— km";
    const duration = formatDuration(movingTime(activity));
    const climb = elevation(activity);
    const dateLabel = date ? fullDateFormat.format(date) : "Data não informada";
    const details = [type, dateLabel, climb > 0 ? `↑ ${numberFormat.format(climb)} m` : ""]
      .filter(Boolean)
      .map((detail) => `<span>${escapeHtml(detail)}</span>`)
      .join("");
    return `<article class="activity-row"><span class="sport-icon">${sportSymbol(type)}</span><div class="activity-main"><p class="activity-name" title="${escapeHtml(name)}">${escapeHtml(name)}</p><div class="activity-meta">${details}</div></div><div class="activity-stats"><div class="activity-distance">${distanceLabel}</div><div class="activity-duration">${duration}</div></div></article>`;
  }).join("");
  list.innerHTML = rows;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderDashboard(activities, period) {
  const totals = activities.reduce((summary, activity) => {
    summary.distance += distance(activity);
    summary.time += movingTime(activity);
    summary.elevation += elevation(activity);
    return summary;
  }, { distance: 0, time: 0, elevation: 0 });

  document.querySelector("#metric-distance").innerHTML = `${decimalFormat.format(totals.distance / 1000)}<small> km</small>`;
  document.querySelector("#metric-time").innerHTML = `${decimalFormat.format(totals.time / 3600)}<small> h</small>`;
  document.querySelector("#metric-elevation").innerHTML = `${numberFormat.format(totals.elevation)}<small> m</small>`;
  document.querySelector("#metric-count").innerHTML = `${numberFormat.format(activities.length)}<small> ${activities.length === 1 ? "treino" : "treinos"}</small>`;
  document.querySelector("#distance-caption").textContent = `Nos últimos ${period} dias`;
  document.querySelector("#count-caption").textContent = activities.length
    ? `${activities.length} sessões no período`
    : "Comece com a próxima sessão";
  document.querySelector("#activity-count").textContent =
    `${activities.length} ${activities.length === 1 ? "atividade" : "atividades"}`;
  document.querySelector("#chart-period").textContent = `Últimos ${period} dias`;
  document.querySelector("#average-distance").innerHTML =
    `${decimalFormat.format(activities.length ? totals.distance / activities.length / 1000 : 0)}<small> km</small>`;
  document.querySelector("#rhythm-note").textContent = activities.length
    ? `Você manteve ${activities.length} ${activities.length === 1 ? "sessão" : "sessões"} de treino nesse período.`
    : "Sem treinos registrados neste período — um bom momento para planejar a próxima sessão.";

  makeChart(activities, period);
  renderActivities(activities);
}

async function loadDashboard() {
  requestController?.abort();
  requestController = new AbortController();
  const period = Number(periodSelect.value);
  setLoading();
  try {
    const response = await fetch(`/api/dashboard?days=${period}`, {
      signal: requestController.signal,
      headers: { Accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok) throw payload.error || { message: "Ocorreu um erro ao buscar seus dados." };

    clearNotice();
    renderDashboard(payload.activities, period);
    document.querySelector("#connection-label").textContent = "Conectado ao Intervals.icu";
    document.querySelector("#connection-label").previousElementSibling.className = "status-dot online";
  } catch (error) {
    if (error.name === "AbortError") return;
    setUnavailable({
      code: error.code || "request_failed",
      message: error.message || "Verifique sua conexão e tente novamente.",
    });
  }
}

periodSelect.addEventListener("change", loadDashboard);
retryButton.addEventListener("click", loadDashboard);
loadDashboard();
