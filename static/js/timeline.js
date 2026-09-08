/* ============================================================
   Linha do tempo de eventos - navegacao por arrasto + filtros
   Dados: GET /api/timeline  e  GET /api/timeline/bounds
   ============================================================ */

const KINDS = ["down", "up", "created", "removed"];
const KIND_LABEL = {
    down: "QUEDA",
    up: "RECUPERACAO",
    created: "CADASTRO",
    removed: "REMOCAO",
};
const LANE_OF = { down: 0, up: 1, created: 2, removed: 2 };
const POLL_MS = 5000;

const RANGE_MS = {
    "1h": 3600e3,
    "6h": 21600e3,
    "24h": 86400e3,
    "7d": 604800e3,
    "30d": 2592000e3,
};

const NICE_INTERVALS = [
    1e3, 2e3, 5e3, 10e3, 15e3, 30e3,
    60e3, 120e3, 300e3, 600e3, 900e3, 1800e3,
    3600e3, 7200e3, 10800e3, 21600e3, 43200e3,
    86400e3, 172800e3, 604800e3, 1209600e3,
];

const state = {
    events: [],
    kinds: new Set(KINDS),
    range: "24h",
    category: "",
    search: "",
    pxPerMs: 0.00005,
    viewStartMs: Date.now() - 86400e3,
    follow: true,
    dragging: false,
    boundsFirstMs: null,
    boundsLastMs: null,
};

const stage = document.getElementById("tl-stage");
const nodesLayer = document.getElementById("tl-nodes");
const outagesLayer = document.getElementById("tl-outages");
const gridLayer = document.getElementById("tl-grid");
const axisLayer = document.getElementById("tl-axis");
const nowLine = document.getElementById("tl-nowline");
const pop = document.getElementById("tl-pop");
const emptyEl = document.getElementById("tl-empty");

const nodeEls = new Map();     // event.id -> element
const outageEls = new Map();   // "o"+event.id -> element
const everShown = new Set();

let layoutQueued = false;
let pinnedId = null;
let popHideTimer = null;

// ------------------------- helpers -------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function parseTs(iso) {
    // timestamps do servidor sao horario local ingenuo -> Date os trata como local
    return new Date(iso).getTime();
}

function pad(n) {
    return String(n).padStart(2, "0");
}

function toLocalIso(d) {
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
}

function fmtDateTime(ms) {
    const d = new Date(ms);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtShort(ms) {
    const d = new Date(ms);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(seconds) {
    if (seconds == null) return "-";
    seconds = Math.round(seconds);
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}min ${seconds % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}min`;
    const days = Math.floor(h / 24);
    return `${days}d ${h % 24}h`;
}

function minPxPerMs() {
    return (stage.clientWidth || 1000) / (420 * 86400e3); // ~14 meses de ponta a ponta
}
function maxPxPerMs() {
    return (stage.clientWidth || 1000) / 20e3; // ~20s de ponta a ponta
}

function viewEndMs() {
    return state.viewStartMs + (stage.clientWidth || 1000) / state.pxPerMs;
}

function xOf(ms) {
    return (ms - state.viewStartMs) * state.pxPerMs;
}

// ------------------------- layout / render -------------------------

function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
        layoutQueued = false;
        layout();
    });
}

function layout() {
    const w = stage.clientWidth;
    const margin = 80;
    const visibleIds = new Set();
    let visibleCount = 0;

    for (const ev of state.events) {
        if (!state.kinds.has(ev.kind)) continue;
        const x = xOf(ev.ms);
        if (x < -margin || x > w + margin) continue;
        visibleCount++;
        visibleIds.add(ev.id);

        let el = nodeEls.get(ev.id);
        if (!el) {
            el = buildNode(ev);
            nodeEls.set(ev.id, el);
            const fresh = !everShown.has(ev.id);
            everShown.add(ev.id);
            if (!fresh || state.dragging) el.classList.add("no-anim", "in");
            nodesLayer.appendChild(el);
            if (fresh && !state.dragging) {
                requestAnimationFrame(() => el.classList.add("in"));
            }
        }
        el.style.left = x + "px";
    }

    for (const [id, el] of nodeEls) {
        if (!visibleIds.has(id)) {
            el.remove();
            nodeEls.delete(id);
        }
    }

    layoutOutages(w, margin);
    layoutGridAndAxis(w);
    updateNowLine(w);

    const noneVisible = visibleCount === 0;
    emptyEl.hidden = !noneVisible;
}

function layoutOutages(w, margin) {
    const keep = new Set();
    const showOutages = state.kinds.has("down") || state.kinds.has("up");

    if (showOutages) {
        for (const ev of state.events) {
            if (ev.kind !== "up" || ev.duration_seconds == null) continue;
            const downMs = ev.ms - ev.duration_seconds * 1000;
            const x1 = xOf(downMs);
            const x2 = xOf(ev.ms);
            if (x2 < -margin || x1 > w + margin) continue;
            const key = "o" + ev.id;
            keep.add(key);
            let el = outageEls.get(key);
            if (!el) {
                el = document.createElement("div");
                el.className = "tl-outage";
                outagesLayer.appendChild(el);
                outageEls.set(key, el);
            }
            el.style.left = x1 + "px";
            el.style.width = Math.max(2, x2 - x1) + "px";
        }
    }

    for (const [key, el] of outageEls) {
        if (!keep.has(key)) {
            el.remove();
            outageEls.delete(key);
        }
    }
}

function niceInterval() {
    const targetMs = 150 / state.pxPerMs;
    return NICE_INTERVALS.find((n) => n >= targetMs) || NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

function fmtTick(ms, interval) {
    const d = new Date(ms);
    if (interval < 60e3) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (interval < 86400e3) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

function layoutGridAndAxis(w) {
    const interval = niceInterval();
    const start = Math.ceil(state.viewStartMs / interval) * interval;
    const end = viewEndMs();

    let grid = "";
    let axis = "";
    for (let t = start; t <= end; t += interval) {
        const x = xOf(t);
        const d = new Date(t);
        const isMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
        const major = interval < 86400e3 && isMidnight;
        grid += `<div class="tl-tick${major ? " major" : ""}" style="left:${x}px"></div>`;
        const label = major ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : fmtTick(t, interval);
        axis += `<div class="tl-axis-label${major ? " major" : ""}" style="left:${x}px">${label}</div>`;
    }
    gridLayer.innerHTML = grid;
    axisLayer.innerHTML = axis;
}

function updateNowLine(w) {
    const x = xOf(Date.now());
    if (x < -4 || x > w + 4) {
        nowLine.style.display = "none";
    } else {
        nowLine.style.display = "";
        nowLine.style.left = x + "px";
    }
}

// ------------------------- nodes + popover -------------------------

function buildNode(ev) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `tl-node k-${ev.kind} lane-${LANE_OF[ev.kind]}`;
    el.innerHTML = `<span class="tl-node-ring"></span><span class="tl-node-core"></span>`;
    el.addEventListener("mouseenter", () => showPop(ev, el));
    el.addEventListener("mouseleave", scheduleHidePop);
    el.addEventListener("focus", () => showPop(ev, el));
    el.addEventListener("blur", scheduleHidePop);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        openEquipmentDetail(ev, el);
    });
    return el;
}

function unpin() {
    pinnedId = null;
    nodeEls.forEach((el) => el.classList.remove("pinned"));
    hidePop();
}

function showPop(ev, el, pinned) {
    if (popHideTimer) {
        clearTimeout(popHideTimer);
        popHideTimer = null;
    }
    if (pinnedId && !pinned && pinnedId !== ev.id) return;

    const rows = [];
    rows.push(`<div class="tl-pop-row"><b>${escapeHtml(ev.ip || "-")}</b>${ev.category ? " &bull; " + escapeHtml(ev.category) : ""}</div>`);
    rows.push(`<div class="tl-pop-row">${fmtDateTime(ev.ms)}</div>`);
    if (ev.kind === "up" && ev.duration_seconds != null) {
        rows.push(`<div class="tl-pop-row">Queda durou <b>${fmtDuration(ev.duration_seconds)}</b></div>`);
    }
    if (ev.kind === "down") {
        rows.push(`<div class="tl-pop-row">Ficou <b style="color:var(--tl-red)">OFFLINE</b></div>`);
    }
    if (ev.kind === "up" && ev.response_time_ms != null) {
        rows.push(`<div class="tl-pop-row">Resposta ao voltar: <b>${ev.response_time_ms} ms</b></div>`);
    }
    if (ev.kind === "created") {
        rows.push(`<div class="tl-pop-row">Equipamento adicionado ao monitoramento</div>`);
    }
    if (ev.kind === "removed") {
        rows.push(`<div class="tl-pop-row">Equipamento retirado do monitoramento</div>`);
    }

    pop.className = `tl-pop k-${ev.kind}`;
    pop.innerHTML =
        `<div class="tl-pop-kind">${KIND_LABEL[ev.kind]}${pinned ? " &bull; fixado" : ""}</div>` +
        `<div class="tl-pop-name">${escapeHtml(ev.equipment_name || "Equipamento #" + ev.equipment_id)}</div>` +
        rows.join("");
    pop.hidden = false;

    const r = el.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = clamp(left, 10, window.innerWidth - pr.width - 10);
    let top = r.top - pr.height - 12;
    if (top < 10) top = r.bottom + 12;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
}

function scheduleHidePop() {
    if (pinnedId) return;
    popHideTimer = setTimeout(hidePop, 120);
}

function hidePop() {
    if (pinnedId) return;
    pop.hidden = true;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ------------------------- modal de detalhes do equipamento -------------------------

const modalOverlay = document.getElementById("tl-modal-overlay");
const detail = {
    event: null,
    window: "24h",
    reqId: 0,
};

function fmtIso(iso) {
    return iso ? fmtDateTime(parseTs(iso)) : "-";
}

function openEquipmentDetail(ev, el) {
    detail.event = ev;
    detail.window = "24h";
    unpin();
    if (el) {
        pinnedId = ev.id;
        el.classList.add("pinned");
    }
    hidePop();

    document.querySelectorAll("#tlm-windows button").forEach((b) =>
        b.classList.toggle("active", b.dataset.window === "24h")
    );
    document.getElementById("tlm-kind").className = "tl-modal-kind k-" + ev.kind;
    document.getElementById("tlm-kind").textContent =
        KIND_LABEL[ev.kind] + " em " + fmtDateTime(ev.ms);
    document.getElementById("tlm-name").textContent =
        ev.equipment_name || "Equipamento #" + ev.equipment_id;
    document.getElementById("tlm-sub").textContent =
        [ev.ip, ev.category].filter(Boolean).join("  •  ") || "-";
    document.getElementById("tlm-stats").innerHTML =
        `<div class="tl-modal-empty">Carregando disponibilidade…</div>`;
    document.getElementById("tlm-events").innerHTML =
        `<div class="tl-modal-empty">Carregando eventos…</div>`;

    modalOverlay.hidden = false;
    loadEquipmentDetail();
    loadEquipmentEvents();
}

function closeEquipmentDetail() {
    modalOverlay.hidden = true;
    detail.event = null;
    unpin();
}

async function loadEquipmentDetail() {
    const ev = detail.event;
    if (!ev || ev.equipment_id == null) {
        document.getElementById("tlm-stats").innerHTML =
            `<div class="tl-modal-empty">Sem ID de equipamento neste evento.</div>`;
        return;
    }
    const rid = ++detail.reqId;
    try {
        const s = await fetch(
            `/api/availability?equipment_id=${ev.equipment_id}&window=${detail.window}`
        ).then((r) => r.json());
        if (rid !== detail.reqId || detail.event !== ev) return;
        renderEquipmentStats(s);
    } catch (err) {
        console.error("availability:", err);
        document.getElementById("tlm-stats").innerHTML =
            `<div class="tl-modal-empty">Falha ao carregar disponibilidade.</div>`;
    }
}

function renderEquipmentStats(s) {
    const up = s.uptime_percent;
    let cls = "dim";
    let upText = "sem dados";
    if (up != null) {
        upText = up + "%";
        cls = up >= 99 ? "good" : up >= 90 ? "warn" : "bad";
    }
    const stats = [
        [`DISPONIBILIDADE (${s.window})`, upText, cls],
        ["VERIFICACOES OK / TOTAL", s.total_checks ? `${s.successful_checks} / ${s.total_checks}` : "0", ""],
        ["FALHAS NO PERIODO", String(s.failed_checks || 0), s.failed_checks ? "bad" : ""],
        [
            "RESPOSTA MEDIA",
            s.avg_response_time_ms != null ? `${s.avg_response_time_ms} ms` : "-",
            "",
        ],
        [
            "RESPOSTA MIN / MAX",
            s.min_response_time_ms != null
                ? `${s.min_response_time_ms} / ${s.max_response_time_ms} ms`
                : "-",
            "dim",
        ],
        ["ULTIMA VEZ ONLINE", fmtIso(s.last_success_at), "good"],
        ["ULTIMA FALHA", fmtIso(s.last_failure_at), s.last_failure_at ? "bad" : "dim"],
        ["ULTIMA VERIFICACAO", fmtIso(s.last_checked_at), "dim"],
    ];
    document.getElementById("tlm-stats").innerHTML = stats
        .map(
            ([label, value, c]) => `
        <div class="tlm-stat">
            <span class="tlm-stat-label">${label}</span>
            <span class="tlm-stat-value ${c}">${escapeHtml(value)}</span>
        </div>`
        )
        .join("");
}

async function loadEquipmentEvents() {
    const ev = detail.event;
    if (!ev || ev.equipment_id == null) {
        document.getElementById("tlm-events").innerHTML =
            `<div class="tl-modal-empty">-</div>`;
        return;
    }
    try {
        const list = await fetch(
            `/api/timeline?equipment_id=${ev.equipment_id}&order=desc&limit=60`
        ).then((r) => r.json());
        if (detail.event !== ev) return;
        if (!list.length) {
            document.getElementById("tlm-events").innerHTML =
                `<div class="tl-modal-empty">Nenhum evento registrado.</div>`;
            return;
        }
        document.getElementById("tlm-events").innerHTML = list
            .map((e) => {
                let extra = "";
                if (e.kind === "up" && e.duration_seconds != null) {
                    extra = "queda de " + fmtDuration(e.duration_seconds);
                } else if (e.kind === "up" && e.response_time_ms != null) {
                    extra = e.response_time_ms + " ms";
                }
                return `
                <div class="tlm-ev k-${e.kind}">
                    <span class="tlm-ev-kind">${KIND_LABEL[e.kind]}</span>
                    <span class="tlm-ev-time">${fmtDateTime(parseTs(e.ts))}</span>
                    <span class="tlm-ev-extra">${escapeHtml(extra)}</span>
                </div>`;
            })
            .join("");
    } catch (err) {
        console.error("equipment events:", err);
        document.getElementById("tlm-events").innerHTML =
            `<div class="tl-modal-empty">Falha ao carregar eventos.</div>`;
    }
}

document.getElementById("tlm-close").addEventListener("click", closeEquipmentDetail);
modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeEquipmentDetail();
});
document.getElementById("tlm-windows").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    detail.window = btn.dataset.window;
    document.querySelectorAll("#tlm-windows button").forEach((b) =>
        b.classList.toggle("active", b === btn)
    );
    loadEquipmentDetail();
});
document.getElementById("tlm-isolate").addEventListener("click", () => {
    const ev = detail.event;
    if (!ev) return;
    const term = ev.ip || ev.equipment_name || "";
    const input = document.getElementById("tl-search");
    input.value = term;
    state.search = term;
    closeEquipmentDetail();
    loadEvents(false);
});

// ------------------------- panning / zoom -------------------------

let dragStartX = 0;
let dragStartView = 0;

stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tl-node")) return;
    e.preventDefault(); // evita selecao de texto / drag-ghost nativo ao arrastar
    state.dragging = true;
    setFollow(false);
    unpin();
    dragStartX = e.clientX;
    dragStartView = state.viewStartMs;
    stage.classList.add("grabbing");
    stage.setPointerCapture(e.pointerId);
});

stage.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    const dx = e.clientX - dragStartX;
    state.viewStartMs = dragStartView - dx / state.pxPerMs;
    scheduleLayout();
});

function endDrag(e) {
    if (!state.dragging) return;
    state.dragging = false;
    stage.classList.remove("grabbing");
    try {
        stage.releasePointerCapture(e.pointerId);
    } catch (_) {}
}
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);

stage.addEventListener(
    "wheel",
    (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            zoomAt(e.clientX, Math.pow(0.88, e.deltaY > 0 ? 1 : -1));
        } else {
            const amount = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            state.viewStartMs += (amount * 1.1) / state.pxPerMs;
            setFollow(false);
        }
        scheduleLayout();
    },
    { passive: false }
);

function zoomAt(clientX, factor) {
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const tUnder = state.viewStartMs + px / state.pxPerMs;
    state.pxPerMs = clamp(state.pxPerMs * factor, minPxPerMs(), maxPxPerMs());
    state.viewStartMs = tUnder - px / state.pxPerMs;
}

document.getElementById("tl-zoom-in").addEventListener("click", () => {
    zoomAt(stage.getBoundingClientRect().left + stage.clientWidth / 2, 1 / 0.7);
    scheduleLayout();
});
document.getElementById("tl-zoom-out").addEventListener("click", () => {
    zoomAt(stage.getBoundingClientRect().left + stage.clientWidth / 2, 0.7);
    scheduleLayout();
});
document.getElementById("tl-fit").addEventListener("click", () => {
    fitToData(true);
});
document.getElementById("tl-now-btn").addEventListener("click", () => goToNow(true));

document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "ArrowLeft") {
        state.viewStartMs -= (stage.clientWidth * 0.15) / state.pxPerMs;
        setFollow(false);
        scheduleLayout();
    } else if (e.key === "ArrowRight") {
        state.viewStartMs += (stage.clientWidth * 0.15) / state.pxPerMs;
        setFollow(false);
        scheduleLayout();
    } else if (e.key === "+" || e.key === "=") {
        zoomAt(stage.getBoundingClientRect().left + stage.clientWidth / 2, 1 / 0.7);
        scheduleLayout();
    } else if (e.key === "-") {
        zoomAt(stage.getBoundingClientRect().left + stage.clientWidth / 2, 0.7);
        scheduleLayout();
    } else if (e.key === "Home") {
        goToNow(true);
    } else if (e.key === "Escape") {
        if (!modalOverlay.hidden) closeEquipmentDetail();
        else unpin();
    }
});

stage.addEventListener("click", (e) => {
    if (!e.target.closest(".tl-node")) unpin();
});

// ------------------------- follow / tween -------------------------

function setFollow(on) {
    state.follow = on;
    const cb = document.getElementById("tl-follow");
    if (cb.checked !== on) cb.checked = on;
}

document.getElementById("tl-follow").addEventListener("change", (e) => {
    state.follow = e.target.checked;
    if (state.follow) goToNow(true);
});

function goToNow(animate) {
    const w = stage.clientWidth;
    const target = Date.now() - (w * 0.82) / state.pxPerMs;
    setFollow(true);
    if (animate) tweenView(target, 480);
    else {
        state.viewStartMs = target;
        scheduleLayout();
    }
}

function tweenView(targetStart, dur) {
    const from = state.viewStartMs;
    const t0 = performance.now();
    (function step(t) {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        state.viewStartMs = from + (targetStart - from) * e;
        layout();
        if (k < 1) requestAnimationFrame(step);
    })(performance.now());
}

let lastFollowLayout = 0;
function frameLoop(t) {
    if (state.follow && !state.dragging) {
        if (t - lastFollowLayout > 66) {
            lastFollowLayout = t;
            const w = stage.clientWidth;
            state.viewStartMs = Date.now() - (w * 0.82) / state.pxPerMs;
            layout();
        }
    } else {
        updateNowLine(stage.clientWidth);
    }
    requestAnimationFrame(frameLoop);
}

// ------------------------- view fitting -------------------------

function fitRange(startMs, endMs) {
    const w = stage.clientWidth || 1000;
    const span = Math.max(endMs - startMs, 60e3);
    state.pxPerMs = clamp(w / span, minPxPerMs(), maxPxPerMs());
    state.viewStartMs = startMs;
}

function fitToData(animate) {
    let first = state.boundsFirstMs;
    let last = state.boundsLastMs;
    if (state.events.length) {
        first = Math.min(first ?? Infinity, state.events[0].ms);
        last = Math.max(last ?? -Infinity, state.events[state.events.length - 1].ms);
    }
    if (first == null || last == null || !isFinite(first)) {
        goToNow(animate);
        return;
    }
    const padMs = Math.max((last - first) * 0.05, 60e3);
    setFollow(false);
    const targetStart = first - padMs;
    fitRange(targetStart, last + padMs);
    scheduleLayout();
}

function applyInitialView() {
    const w = stage.clientWidth || 1000;
    if (state.range === "all") {
        fitToData(false);
        return;
    }
    const now = Date.now();
    fitRange(now - RANGE_MS[state.range], now);
    // desloca para deixar "agora" a ~82% da largura
    state.viewStartMs = now - (w * 0.82) / state.pxPerMs;
    setFollow(true);
}

// ------------------------- data -------------------------

async function loadBounds() {
    try {
        const b = await fetch("/api/timeline/bounds").then((r) => r.json());
        state.boundsFirstMs = b.first_ts ? parseTs(b.first_ts) : null;
        state.boundsLastMs = b.last_ts ? parseTs(b.last_ts) : null;
        for (const k of KINDS) {
            const el = document.getElementById("cnt-" + k);
            if (el) el.textContent = (b.by_kind && b.by_kind[k]) || 0;
        }
    } catch (err) {
        console.error("bounds:", err);
    }
}

async function loadCategories() {
    try {
        const cats = await fetch("/api/categories").then((r) => r.json());
        const sel = document.getElementById("tl-category");
        const cur = sel.value;
        sel.innerHTML =
            `<option value="">Todas as bases</option>` +
            cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
        if (cats.includes(cur)) sel.value = cur;
    } catch (err) {
        console.error("categories:", err);
    }
}

async function loadEvents(keepView) {
    const params = new URLSearchParams();
    if (state.range !== "all") {
        params.set("since", toLocalIso(new Date(Date.now() - RANGE_MS[state.range] - 3600e3)));
    }
    if (state.category) params.set("category", state.category);
    if (state.search) params.set("search", state.search);
    params.set("limit", "8000");

    try {
        const list = await fetch("/api/timeline?" + params.toString()).then((r) => r.json());
        state.events = list
            .map((e) => ({ ...e, ms: parseTs(e.ts) }))
            .sort((a, b) => a.ms - b.ms);
        updateFooter();
        if (!keepView) applyInitialView();
        scheduleLayout();
    } catch (err) {
        console.error("events:", err);
    }
}

function updateFooter() {
    document.getElementById("tl-foot-count").textContent = `${state.events.length} eventos`;
    if (state.events.length) {
        const a = state.events[0].ms;
        const b = state.events[state.events.length - 1].ms;
        document.getElementById("tl-foot-span").textContent = `${fmtShort(a)}  ->  ${fmtShort(b)}`;
    } else {
        document.getElementById("tl-foot-span").textContent = "sem eventos";
    }
}

// ------------------------- filtros UI -------------------------

document.getElementById("tl-kind-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".tl-chip");
    if (!chip) return;
    const kind = chip.dataset.kind;
    if (state.kinds.has(kind)) state.kinds.delete(kind);
    else state.kinds.add(kind);
    if (state.kinds.size === 0) state.kinds.add(kind); // nunca deixa tudo desligado
    chip.classList.toggle("active", state.kinds.has(kind));
    scheduleLayout();
});

document.getElementById("tl-range").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.range = btn.dataset.range;
    document.querySelectorAll("#tl-range button").forEach((b) => b.classList.toggle("active", b === btn));
    loadEvents(false);
});

let searchTimer = null;
document.getElementById("tl-search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadEvents(true), 280);
});

document.getElementById("tl-category").addEventListener("change", (e) => {
    state.category = e.target.value;
    loadEvents(true);
});

// ------------------------- clock + resize + poll -------------------------

function tickClock() {
    document.getElementById("tl-clock").textContent = new Date().toLocaleTimeString("pt-BR");
}

let resizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        state.pxPerMs = clamp(state.pxPerMs, minPxPerMs(), maxPxPerMs());
        scheduleLayout();
    }, 120);
});

// ------------------------- init -------------------------

(async function init() {
    tickClock();
    setInterval(tickClock, 1000);

    await Promise.all([loadBounds(), loadCategories()]);
    await loadEvents(false);

    requestAnimationFrame(frameLoop);

    setInterval(async () => {
        await loadBounds();
        await loadEvents(true);
    }, POLL_MS);
})();
