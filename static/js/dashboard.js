// Dashboard do Pingador: busca dados via polling (sem WebSocket, sem reload manual)
// e atualiza a tela + graficos periodicamente.

const POLL_INTERVAL_MS = 3000;

const STATUS_LABELS = {
    online: "ONLINE",
    offline: "OFFLINE",
    aguardando: "AGUARDANDO",
};

const COLOR_GREEN = "#34d67a";
const COLOR_RED = "#f04952";
const COLOR_MUTED = "#6f8a78";

let charts = {};
let latestAllEquipments = [];
let latestEquipments = [];
let latestHistoryByEquipment = {};
let selectedCategory = "";
let selectedStatus = "";
let searchQuery = "";
let knownCategories = [];

function fmtDateTime(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    return d.toLocaleString("pt-BR");
}

function fmtTime(iso) {
    if (!iso) return "--:--";
    const d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ---------------- Relogio do topo ----------------

const LAYOUT_STORAGE_KEY = "equipmentLayoutMode";
const DEFAULT_EQUIPMENT_LAYOUT = "grid";

function tickClock() {
    const now = new Date();
    document.getElementById("topbar-clock").textContent = now.toLocaleTimeString("pt-BR");
    document.getElementById("topbar-date").textContent = now.toLocaleDateString("pt-BR");
}

function applyEquipmentLayoutMode(mode) {
    const container = document.getElementById("equipments-list");
    const gridButton = document.getElementById("btn-layout-grid");
    const listButton = document.getElementById("btn-layout-list");

    const layoutMode = mode === "list" ? "list" : "grid";
    container.classList.toggle("list-mode", layoutMode === "list");
    gridButton.classList.toggle("active", layoutMode === "grid");
    listButton.classList.toggle("active", layoutMode === "list");
    localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode);
}

function initEquipmentLayoutMode() {
    const savedMode = localStorage.getItem(LAYOUT_STORAGE_KEY);
    applyEquipmentLayoutMode(savedMode === "list" ? "list" : "grid");

    document.getElementById("btn-layout-grid").addEventListener("click", () => applyEquipmentLayoutMode("grid"));
    document.getElementById("btn-layout-list").addEventListener("click", () => applyEquipmentLayoutMode("list"));
}

let detailEquipmentId = null;
let availabilityWindow = "24h";
let availabilityChart = null;

function openEquipmentDetails(id) {
    const equipment = latestEquipments.find((eq) => eq.id === id);
    if (!equipment) return;

    detailEquipmentId = id;
    loadAvailability();

    const history = latestHistoryByEquipment[id] || [];
    document.getElementById("detail-name").textContent = equipment.name;
    document.getElementById("detail-ip").textContent = equipment.ip;
    document.getElementById("detail-category").textContent = equipment.category || "-";
    document.getElementById("detail-source").textContent =
        equipment.source === "excel" ? "Planilha (sincronizado)" : "Manual";
    document.getElementById("detail-description").textContent = equipment.description || "-";
    document.getElementById("detail-status").textContent = equipment.status.toUpperCase();
    document.getElementById("detail-last-checked").textContent = fmtDateTime(equipment.last_checked);
    document.getElementById("detail-response-time").textContent = equipment.last_response_time_ms !== null ? `${equipment.last_response_time_ms} ms` : "-";
    document.getElementById("detail-monitoring").textContent = equipment.monitoring_active ? "Ativo" : "Pausado";
    document.getElementById("detail-frequency").textContent = `${equipment.frequency}s`;

    const historyList = document.getElementById("detail-history-list");
    if (history.length === 0) {
        historyList.innerHTML = `<div class="detail-history-empty">Nenhuma verificacao registrada.</div>`;
    } else {
        historyList.innerHTML = history
            .slice(-10)
            .reverse()
            .map((item) => {
                const statusLabel = item.success ? "OK" : "FALHA";
                const value = item.success ? `${item.response_time_ms} ms` : "-";
                return `
                    <div class="detail-history-item ${item.success ? "history-up" : "history-down"}">
                        <span>${fmtTime(item.timestamp)}</span>
                        <span>${statusLabel}</span>
                        <span>${value}</span>
                    </div>`;
            })
            .join("");
    }

    document.getElementById("detail-modal-overlay").classList.remove("hidden");
}

function closeEquipmentDetails() {
    document.getElementById("detail-modal-overlay").classList.add("hidden");
    detailEquipmentId = null;
    if (availabilityChart) {
        availabilityChart.destroy();
        availabilityChart = null;
    }
}

function initDetailModal() {
    const overlay = document.getElementById("detail-modal-overlay");
    document.getElementById("btn-close-detail").addEventListener("click", closeEquipmentDetails);
    overlay.addEventListener("click", (evt) => {
        if (evt.target === overlay) closeEquipmentDetails();
    });

    document.querySelectorAll(".window-switch button").forEach((btn) => {
        btn.addEventListener("click", () => {
            availabilityWindow = btn.dataset.window;
            document.querySelectorAll(".window-switch button").forEach((b) =>
                b.classList.toggle("active", b === btn)
            );
            loadAvailability();
        });
    });
}

// ---------------- Disponibilidade (SQLite) ----------------

async function loadAvailability() {
    const id = detailEquipmentId;
    if (id === null) return;
    const win = availabilityWindow;

    try {
        const [summaryRes, seriesRes] = await Promise.all([
            fetch(`/api/availability?equipment_id=${id}&window=${win}`),
            fetch(`/api/availability/series?equipment_id=${id}&window=${win}`),
        ]);
        const summary = await summaryRes.json();
        const series = await seriesRes.json();
        if (detailEquipmentId !== id || availabilityWindow !== win) return; // trocou no meio

        renderAvailabilitySummary(summary);
        renderAvailabilityChart(series);
    } catch (err) {
        console.error("Falha ao carregar disponibilidade:", err);
    }
}

function renderAvailabilitySummary(s) {
    const uptime = s.uptime_percent;
    const uptimeEl = document.getElementById("avail-uptime");
    uptimeEl.textContent = uptime === null || uptime === undefined ? "sem dados" : `${uptime}%`;
    uptimeEl.className =
        "avail-stat-value " +
        (uptime === null || uptime === undefined
            ? ""
            : uptime >= 99
            ? "online-text"
            : uptime >= 90
            ? "warn-text"
            : "offline-text");

    document.getElementById("avail-checks").textContent =
        s.total_checks ? `${s.successful_checks} / ${s.total_checks}` : "0";
    document.getElementById("avail-avg").textContent =
        s.avg_response_time_ms !== null && s.avg_response_time_ms !== undefined
            ? `${s.avg_response_time_ms} ms`
            : "-";
    document.getElementById("avail-last-success").textContent = fmtDateTime(s.last_success_at);
    document.getElementById("avail-last-failure").textContent = fmtDateTime(s.last_failure_at);
}

function renderAvailabilityChart(series) {
    const canvas = document.getElementById("availability-canvas");
    if (!canvas) return;

    const labels = series.map((p) => p.bucket_start);
    const values = series.map((p) => p.uptime_percent);
    const bucketUnit = series.length && series[0].bucket === "hour" ? "hour" : "day";
    const colors = values.map((v) =>
        v === null ? COLOR_MUTED : v >= 99 ? COLOR_GREEN : v >= 90 ? "#e0a53d" : COLOR_RED
    );

    const config = {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    data: values,
                    backgroundColor: colors,
                    borderWidth: 0,
                    borderRadius: 2,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const p = series[ctx.dataIndex];
                            return p.uptime_percent === null
                                ? "sem dados"
                                : `${p.uptime_percent}% de pe (${p.successful_checks}/${p.total_checks})`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    type: "time",
                    time: {
                        unit: bucketUnit,
                        tooltipFormat: bucketUnit === "hour" ? "dd/MM HH:mm" : "dd/MM",
                    },
                    grid: { color: "#1e2b22" },
                    ticks: { color: COLOR_MUTED, font: { size: 9 }, maxTicksLimit: 8 },
                },
                y: {
                    min: 0,
                    max: 100,
                    grid: { color: "#1e2b22" },
                    ticks: {
                        color: COLOR_MUTED,
                        font: { size: 9 },
                        maxTicksLimit: 5,
                        callback: (v) => `${v}%`,
                    },
                },
            },
        },
    };

    if (availabilityChart) {
        availabilityChart.data = config.data;
        availabilityChart.options = config.options;
        availabilityChart.update();
    } else {
        availabilityChart = new Chart(canvas.getContext("2d"), config);
    }
}

// ---------------- Renderizacao dos cards de equipamento ----------------

const equipmentCharts = {}; // equipmentId -> instancia Chart.js

function updateCategoryFilterOptions(equipments) {
    const categories = Array.from(new Set(equipments.map((eq) => eq.category).filter(Boolean))).sort();
    const changed =
        categories.length !== knownCategories.length ||
        categories.some((c, i) => c !== knownCategories[i]);
    if (!changed) return;
    knownCategories = categories;

    const select = document.getElementById("filter-category");
    const current = select.value;
    select.innerHTML =
        `<option value="">Todas as bases</option>` +
        categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (categories.includes(current)) select.value = current;
}

function matchesSearch(eq, query) {
    if (!query) return true;
    const haystack = [
        eq.name,
        eq.ip,
        eq.description,
        eq.category,
        STATUS_LABELS[eq.status] || eq.status,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    return haystack.includes(query);
}

function renderEquipments(allEquipments, historyByEquipment) {
    latestAllEquipments = allEquipments;
    updateCategoryFilterOptions(allEquipments);
    const query = searchQuery.trim().toLowerCase();
    const equipments = allEquipments.filter(
        (eq) =>
            (!selectedCategory || eq.category === selectedCategory) &&
            (!selectedStatus || eq.status === selectedStatus) &&
            matchesSearch(eq, query)
    );

    const container = document.getElementById("equipments-list");
    const currentIds = new Set(equipments.map((e) => e.id));

    // remove graficos/cards de equipamentos que nao existem mais
    Object.keys(equipmentCharts).forEach((idStr) => {
        const id = Number(idStr);
        if (!currentIds.has(id)) {
            equipmentCharts[id].destroy();
            delete equipmentCharts[id];
        }
    });
    container.querySelectorAll(".equipment-card").forEach((el) => {
        const id = Number(el.dataset.id);
        if (!currentIds.has(id)) el.remove();
    });

    if (equipments.length === 0) {
        container.innerHTML = allEquipments.length === 0
            ? `<div class="empty-state">Nenhum equipamento cadastrado ainda. Clique em "+ Novo equipamento" para comecar.</div>`
            : `<div class="empty-state">Nenhum equipamento encontrado para essa busca/filtro.</div>`;
        return;
    }
    latestEquipments = equipments;
    latestHistoryByEquipment = historyByEquipment;

    const empty = container.querySelector(".empty-state");
    if (empty) empty.remove();

    equipments.forEach((eq) => {
        const pausedClass = eq.monitoring_active ? "" : "paused";
        const responseTime =
            eq.last_response_time_ms !== null && eq.last_response_time_ms !== undefined
                ? `${eq.last_response_time_ms} ms`
                : eq.status === "offline"
                ? "- ms"
                : "-";

        let card = document.getElementById(`equipment-card-${eq.id}`);
        if (!card) {
            card = document.createElement("div");
            card.id = `equipment-card-${eq.id}`;
            card.dataset.id = eq.id;
            card.innerHTML = `
                <div class="equipment-title">
                    <span class="equipment-name-group">
                        <span class="dot" id="equipment-dot-${eq.id}"></span>
                        <span>${escapeHtml(eq.name)}</span>
                    </span>
                    <span class="status-badge" id="equipment-badge-${eq.id}"></span>
                </div>
                <div class="equipment-description" id="equipment-description-${eq.id}"></div>
                <div class="equipment-meta-row">
                    <span class="equipment-ip-group">
                        <span id="equipment-ip-${eq.id}"></span>
                        <span class="category-tag" id="equipment-category-${eq.id}"></span>
                    </span>
                    <span class="equipment-response">
                        <span class="value" id="equipment-value-${eq.id}"></span>
                        <span class="label">Ultima verificacao<br><span id="equipment-checked-${eq.id}"></span></span>
                    </span>
                </div>
                <div class="equipment-chart-wrap">
                    <canvas id="equipment-canvas-${eq.id}"></canvas>
                </div>
                <div class="equipment-actions">
                    <button class="btn btn-secondary btn-small" onclick="toggleEquipment(${eq.id})" id="equipment-toggle-${eq.id}"></button>
                    <button class="btn btn-secondary btn-small" onclick="editEquipment(${eq.id})">Editar</button>
                    <button class="btn btn-danger btn-small" onclick="removeEquipment(${eq.id})">Remover</button>
                </div>`;
            card.addEventListener("click", (evt) => {
                if (evt.target.closest("button")) return;
                openEquipmentDetails(eq.id);
            });
        }
        // appendChild em um no ja existente apenas o move para o final,
        // garantindo que a ordem final siga a ordem de "equipments"
        // mesmo apos remocoes/recriacoes causadas pelo filtro de base
        container.appendChild(card);
        card.className = `card equipment-card status-${eq.status} ${pausedClass}`;

        document.getElementById(`equipment-dot-${eq.id}`).className =
            `dot ${eq.status === "offline" ? "dot-offline" : "dot-online"}`;
        const badge = document.getElementById(`equipment-badge-${eq.id}`);
        badge.className = `status-badge status-${eq.status}`;
        badge.textContent = STATUS_LABELS[eq.status] || eq.status;
        document.getElementById(`equipment-ip-${eq.id}`).textContent = eq.ip;
        document.getElementById(`equipment-category-${eq.id}`).textContent = eq.category || "";
        const descriptionEl = document.getElementById(`equipment-description-${eq.id}`);
        descriptionEl.textContent = eq.description || "";
        descriptionEl.classList.toggle("hidden", !eq.description);
        document.getElementById(`equipment-value-${eq.id}`).textContent = responseTime;
        document.getElementById(`equipment-checked-${eq.id}`).textContent = fmtTime(eq.last_checked);
        const toggleBtn = document.getElementById(`equipment-toggle-${eq.id}`);
        toggleBtn.textContent = eq.monitoring_active ? "Pausar" : "Ativar";

        // grafico de resposta (linha), com eixos visiveis (estilo painel)
        const samples = historyByEquipment[eq.id] || [];
        const values = samples.map((s) => (s.success ? s.response_time_ms : 0));
        const labels = samples.map((s) => s.timestamp);
        const lineColor = eq.status === "offline" ? COLOR_RED : COLOR_GREEN;

        const canvas = document.getElementById(`equipment-canvas-${eq.id}`);
        const config = {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        data: values,
                        borderColor: lineColor,
                        backgroundColor: lineColor,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        fill: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: {
                    x: {
                        type: "time",
                        time: { unit: "minute", tooltipFormat: "HH:mm" },
                        grid: { color: "#1e2b22" },
                        ticks: { color: COLOR_MUTED, font: { size: 9 }, maxTicksLimit: 4 },
                    },
                    y: {
                        min: 0,
                        suggestedMax: 80,
                        grid: { color: "#1e2b22" },
                        ticks: {
                            color: COLOR_MUTED,
                            font: { size: 9 },
                            maxTicksLimit: 3,
                            callback: (v) => `${v} ms`,
                        },
                    },
                },
            },
        };

        if (equipmentCharts[eq.id]) {
            equipmentCharts[eq.id].data = config.data;
            equipmentCharts[eq.id].options = config.options;
            equipmentCharts[eq.id].update();
        } else {
            equipmentCharts[eq.id] = new Chart(canvas.getContext("2d"), config);
        }
    });
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------------- Resumo do dashboard ----------------

function renderSummary(summary, equipments) {
    const nameById = new Map(equipments.map((eq) => [eq.id, eq.name]));

    document.getElementById("summary-total").textContent = summary.total;
    document.getElementById("summary-online").textContent = summary.online;
    document.getElementById("summary-offline").textContent = summary.offline;
    document.getElementById("summary-availability").textContent = `${summary.availability_percent}%`;
    document.getElementById("summary-availability-bar").style.width = `${summary.availability_percent}%`;

    document.getElementById("last-down-name").textContent = summary.last_down
        ? nameById.get(summary.last_down.equipment_id) || `Equipamento #${summary.last_down.equipment_id}`
        : "Nenhuma queda registrada";
    document.getElementById("last-down").textContent = summary.last_down
        ? fmtDateTime(summary.last_down.down_at)
        : "-";
    document.getElementById("last-up-name").textContent = summary.last_up
        ? nameById.get(summary.last_up.equipment_id) || `Equipamento #${summary.last_up.equipment_id}`
        : "Nenhuma recuperacao registrada";
    document.getElementById("last-up").textContent = summary.last_up
        ? fmtDateTime(summary.last_up.up_at)
        : "-";
}

// ---------------- Sparklines do resumo ----------------

function buildSparkline(canvasId, values, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const config = {
        type: "line",
        data: {
            labels: values.map((_, i) => i),
            datasets: [
                {
                    data: values,
                    borderColor: color,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.35,
                    fill: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
        },
    };
    if (charts[canvasId]) {
        charts[canvasId].data = config.data;
        charts[canvasId].update();
    } else {
        charts[canvasId] = new Chart(canvas.getContext("2d"), config);
    }
}

function renderSummarySparklines(equipments, historyByEquipment) {
    // agrega o historico de tempo de resposta de todos os equipamentos por posicao da amostra
    const maxLen = Math.max(0, ...equipments.map((eq) => (historyByEquipment[eq.id] || []).length));
    const avgAll = [];
    const avgOnline = [];
    const avgOffline = [];

    for (let i = 0; i < maxLen; i++) {
        let sumAll = 0, countAll = 0;
        let sumOnline = 0, countOnline = 0;
        let sumOffline = 0, countOffline = 0;

        equipments.forEach((eq) => {
            const samples = historyByEquipment[eq.id] || [];
            const s = samples[i];
            if (!s) return;
            const v = s.success ? s.response_time_ms : 0;
            sumAll += v;
            countAll++;
            if (eq.status === "offline") {
                sumOffline += v;
                countOffline++;
            } else {
                sumOnline += v;
                countOnline++;
            }
        });

        avgAll.push(countAll ? sumAll / countAll : 0);
        avgOnline.push(countOnline ? sumOnline / countOnline : 0);
        avgOffline.push(countOffline ? sumOffline / countOffline : 0);
    }

    buildSparkline("spark-total", avgAll, COLOR_GREEN);
    buildSparkline("spark-online", avgOnline, COLOR_GREEN);
    buildSparkline("spark-offline", avgOffline, COLOR_RED);
}

// ---------------- Linha do tempo de eventos (minimalista) ----------------

function renderTimeline(events) {
    const relevant = events.filter((e) => e.down_at || e.up_at);
    const track = document.getElementById("timeline-points");
    const startEl = document.getElementById("timeline-start");
    const endEl = document.getElementById("timeline-end");

    if (relevant.length === 0) {
        track.innerHTML = "";
        startEl.textContent = "--:--";
        endEl.textContent = "--:--";
        return;
    }

    const points = relevant.map((e) => ({
        time: e.down_at || e.up_at,
        type: e.down_at ? "down" : "up",
    }));
    points.sort((a, b) => new Date(a.time) - new Date(b.time));

    const first = new Date(points[0].time).getTime();
    const last = new Date(points[points.length - 1].time).getTime();
    const span = Math.max(last - first, 1);

    startEl.textContent = fmtTime(points[0].time);
    endEl.textContent = fmtTime(points[points.length - 1].time);

    track.innerHTML = points
        .map((p) => {
            const pct = ((new Date(p.time).getTime() - first) / span) * 100;
            return `<span class="timeline-point ${p.type}" style="left:${pct}%" title="${fmtDateTime(p.time)}"></span>`;
        })
        .join("");
}

// ---------------- Polling ----------------

async function refreshData() {
    try {
        const [equipmentsRes, summaryRes, eventsRes, historyRes] = await Promise.all([
            fetch("/api/equipments"),
            fetch("/api/dashboard"),
            fetch("/api/events?limit=100"),
            fetch("/api/ping-history"),
        ]);
        const equipments = await equipmentsRes.json();
        const summary = await summaryRes.json();
        const events = await eventsRes.json();
        const history = await historyRes.json();

        renderSummary(summary, equipments);
        renderSummarySparklines(equipments, history);
        renderEquipments(equipments, history);
        renderTimeline(events);
    } catch (err) {
        console.error("Falha ao atualizar dados do dashboard:", err);
    }
}

// ---------------- Acoes de equipamento ----------------

async function toggleEquipment(id) {
    await fetch(`/api/equipments/${id}/toggle`, { method: "POST" });
    refreshData();
}

async function removeEquipment(id) {
    if (!confirm("Remover este equipamento? O historico dele tambem sera apagado.")) return;
    await fetch(`/api/equipments/${id}`, { method: "DELETE" });
    refreshData();
}

function editEquipment(id) {
    const eq = latestAllEquipments.find((e) => e.id === id);
    if (!eq) return;
    formError.classList.add("hidden");
    formEquipment.reset();
    document.getElementById("input-id").value = eq.id;
    document.getElementById("input-name").value = eq.name || "";
    document.getElementById("input-ip").value = eq.ip || "";
    document.getElementById("input-description").value = eq.description || "";
    document.getElementById("input-category").value = eq.category || "";
    document.getElementById("input-frequency").value = eq.frequency || 30;
    document.getElementById("modal-title").textContent = "Editar equipamento";
    document.getElementById("btn-submit-equipment").textContent = "Salvar";
    fillCategoryOptions();
    modalOverlay.classList.remove("hidden");
}

// ---------------- Modal de cadastro / edicao ----------------

const modalOverlay = document.getElementById("modal-overlay");
const formEquipment = document.getElementById("form-equipment");
const formError = document.getElementById("form-error");

function fillCategoryOptions() {
    const datalist = document.getElementById("category-options");
    if (!datalist) return;
    const cats = [...new Set(latestAllEquipments.map((e) => e.category).filter(Boolean))].sort();
    datalist.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

document.getElementById("btn-open-modal").addEventListener("click", () => {
    formError.classList.add("hidden");
    formEquipment.reset();
    document.getElementById("input-id").value = "";
    document.getElementById("modal-title").textContent = "Novo equipamento";
    document.getElementById("btn-submit-equipment").textContent = "Cadastrar";
    fillCategoryOptions();
    modalOverlay.classList.remove("hidden");
});

document.getElementById("btn-cancel").addEventListener("click", () => {
    modalOverlay.classList.add("hidden");
});

modalOverlay.addEventListener("click", (evt) => {
    if (evt.target === modalOverlay) modalOverlay.classList.add("hidden");
});

formEquipment.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const id = document.getElementById("input-id").value;
    const payload = {
        name: document.getElementById("input-name").value,
        ip: document.getElementById("input-ip").value,
        description: document.getElementById("input-description").value,
        category: document.getElementById("input-category").value,
        frequency: document.getElementById("input-frequency").value,
    };

    const res = await fetch(id ? `/api/equipments/${id}` : "/api/equipments", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const data = await res.json();
        formError.textContent =
            data.error || (id ? "Erro ao salvar equipamento." : "Erro ao cadastrar equipamento.");
        formError.classList.remove("hidden");
        return;
    }

    modalOverlay.classList.add("hidden");
    refreshData();
});

// ---------------- Filtro por base/categoria ----------------

document.getElementById("filter-category").addEventListener("change", (evt) => {
    selectedCategory = evt.target.value;
    renderEquipments(latestAllEquipments, latestHistoryByEquipment);
});

document.getElementById("filter-status").addEventListener("change", (evt) => {
    selectedStatus = evt.target.value;
    renderEquipments(latestAllEquipments, latestHistoryByEquipment);
});

document.getElementById("filter-search").addEventListener("input", (evt) => {
    searchQuery = evt.target.value;
    renderEquipments(latestAllEquipments, latestHistoryByEquipment);
});

// ---------------- Inicializacao ----------------

initEquipmentLayoutMode();
initDetailModal();
tickClock();
setInterval(tickClock, 1000);
refreshData();
setInterval(refreshData, POLL_INTERVAL_MS);
