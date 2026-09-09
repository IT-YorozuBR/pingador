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

// largura (px) de uma "celula" de agrupamento: eventos da mesma faixa/tipo
// que caem dentro dessa distancia viram um unico marcador com contagem.
// ao dar zoom in a celula cobre menos tempo -> os grupos se desfazem.
const CLUSTER_PX = 26;

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
    focusEquipmentId: null,   // equipamento em foco na linha do tempo
    focusEquipmentName: "",
    cluster: true,            // agrupar marcadores quando muito juntos (zoom out)
};

const stage = document.getElementById("tl-stage");
const nodesLayer = document.getElementById("tl-nodes");
const trackLayer = document.getElementById("tl-equip-track");
const outagesLayer = document.getElementById("tl-outages");
const gridLayer = document.getElementById("tl-grid");
const axisLayer = document.getElementById("tl-axis");
const nowLine = document.getElementById("tl-nowline");
const pop = document.getElementById("tl-pop");
const emptyEl = document.getElementById("tl-empty");
const focusSvg = document.getElementById("tl-focus");
const focusLabel = document.getElementById("tl-focus-label");
const bellBtn = document.getElementById("tl-bell");
const bellBadge = document.getElementById("tl-bell-badge");
const bellPanel = document.getElementById("tl-bell-panel");
const bellList = document.getElementById("tl-bell-list");

const knownEventIds = new Set(); // ids ja vistos -> nao notifica de novo
let notifSeeded = false;         // 1a carga so semeia, nao gera notificacao
let notifItems = [];             // { ev, read } mais recente primeiro (cap 50)
let unreadCount = 0;

const AXIS_H = 34; // deve casar com --tl-axis-h no CSS
let focusEv = null; // evento (down/up) com a "linha da queda" em foco no hover

const nodeEls = new Map();     // event.id -> element
const clusterEls = new Map();  // chave da celula -> element de grupo
const outageEls = new Map();   // "o"+event.id -> element
const everShown = new Set();
let equipmentById = new Map(); // equipment_id -> objeto de /api/equipments (p/ descricao etc.)

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

// tamanho (em ms) da celula de agrupamento no zoom atual. atrelado a escala
// de intervalos "bonitos" do eixo -> ao dar zoom a granularidade cai em degraus
// estaveis (os grupos nao ficam piscando a cada pixel de pan/zoom).
function clusterBinMs() {
    const raw = CLUSTER_PX / state.pxPerMs;
    return NICE_INTERVALS.find((n) => n >= raw) || NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

function layout() {
    const w = stage.clientWidth;
    const margin = 80;
    const visibleIds = new Set();
    const visibleClusterKeys = new Set();
    let visibleCount = 0;
    const fid = state.focusEquipmentId;
    stage.classList.toggle("equip-focusing", fid != null);

    // 1) coleta os eventos visiveis
    const inView = [];
    for (const ev of state.events) {
        if (!state.kinds.has(ev.kind)) continue;
        const x = xOf(ev.ms);
        if (x < -margin || x > w + margin) continue;
        if (fid == null || ev.equipment_id === fid) visibleCount++;
        inView.push({ ev, x });
    }

    // 2) agrupa por faixa + tipo + celula (quando "agrupar" ligado e sem foco
    //    em equipamento). celula com 1 evento -> marcador normal.
    const singles = [];
    const groups = [];
    if (state.cluster && fid == null) {
        const binMs = clusterBinMs();
        const bins = new Map();
        for (const item of inView) {
            const lane = LANE_OF[item.ev.kind];
            const cell = Math.round(item.ev.ms / binMs);
            const key = lane + "|" + item.ev.kind + "|" + cell;
            let b = bins.get(key);
            if (!b) {
                b = { key, lane, kind: item.ev.kind, sumX: 0, members: [] };
                bins.set(key, b);
            }
            b.sumX += item.x;
            b.members.push(item.ev);
        }
        for (const b of bins.values()) {
            if (b.members.length === 1) {
                singles.push({ ev: b.members[0], x: b.sumX });
            } else {
                groups.push({
                    key: b.key,
                    kind: b.kind,
                    lane: b.lane,
                    x: b.sumX / b.members.length,
                    members: b.members,
                });
            }
        }
    } else {
        for (const item of inView) singles.push(item);
    }

    // 3) marcadores individuais
    for (const { ev, x } of singles) {
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
        el.classList.toggle("unrecovered", !!ev._unrecovered);
        el.classList.toggle("equip-dim", fid != null && ev.equipment_id !== fid);
        el.classList.toggle("equip-hi", fid != null && ev.equipment_id === fid);
    }

    for (const [id, el] of nodeEls) {
        if (!visibleIds.has(id)) {
            el.remove();
            nodeEls.delete(id);
        }
    }

    // 4) marcadores de grupo
    for (const g of groups) {
        visibleClusterKeys.add(g.key);
        let el = clusterEls.get(g.key);
        if (!el) {
            el = buildCluster();
            clusterEls.set(g.key, el);
            nodesLayer.appendChild(el);
        }
        el._cluster = g;
        el.className = `tl-node tl-cluster k-${g.kind} lane-${g.lane} in` +
            (state.dragging ? " no-anim" : "");
        el.style.left = g.x + "px";
        el.querySelector(".tl-cluster-count").textContent =
            g.members.length > 99 ? "99+" : String(g.members.length);
    }

    for (const [key, el] of clusterEls) {
        if (!visibleClusterKeys.has(key)) {
            el.remove();
            clusterEls.delete(key);
        }
    }

    layoutOutages(w, margin);
    layoutGridAndAxis(w);
    updateNowLine(w);
    drawEquipTrack(w, margin);
    if (focusEv) showFocus(focusEv, false); // mantem a "linha da queda" alinhada ao dar pan/zoom

    emptyEl.hidden = visibleCount !== 0 ? true : false;
}

// desenha a "trilha" do equipamento em foco: liga em ordem cronologica
// todas as movimentacoes dele (queda / recuperacao / cadastro / remocao)
function drawEquipTrack(w, margin) {
    const fid = state.focusEquipmentId;
    if (fid == null) {
        if (trackLayer.innerHTML) trackLayer.innerHTML = "";
        return;
    }
    const laneFrac = [0.24, 0.56, 0.85];
    const h = stage.clientHeight - AXIS_H;
    const pts = [];
    for (const ev of state.events) {
        if (ev.equipment_id !== fid || !state.kinds.has(ev.kind)) continue;
        const x = xOf(ev.ms);
        if (x < -margin * 4 || x > w + margin * 4) continue;
        pts.push([x, (stage.clientHeight - AXIS_H) * laneFrac[LANE_OF[ev.kind]]]);
    }
    if (pts.length < 1) {
        trackLayer.innerHTML = "";
        return;
    }
    trackLayer.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const line =
        pts.length > 1
            ? `<polyline points="${pts.map((p) => p.join(",")).join(" ")}"/>`
            : "";
    const dots = pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3"/>`).join("");
    trackLayer.innerHTML = line + dots;
}

function layoutOutages(w, margin) {
    const keep = new Set();
    const showOutages = state.kinds.has("down") || state.kinds.has("up");
    const fid = state.focusEquipmentId;

    if (showOutages) {
        for (const ev of state.events) {
            if (ev.kind !== "up" || ev.duration_seconds == null) continue;
            if (fid != null && ev.equipment_id !== fid) continue; // foco: some com o resto
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

// liga cada queda a sua recuperacao (_mate / _recoveredAt / _downAt) e
// marca as quedas que nunca voltaram (_unrecovered)
function computeEventLinks() {
    const byEq = new Map();
    for (const ev of state.events) {
        ev._unrecovered = false;
        ev._recoveredAt = null;
        ev._downAt = null;
        ev._mate = null;
        if (ev.equipment_id == null) continue;
        if (!byEq.has(ev.equipment_id)) byEq.set(ev.equipment_id, []);
        byEq.get(ev.equipment_id).push(ev);
    }
    let count = 0;
    for (const list of byEq.values()) {
        let openDown = null;
        let lastRelevant = null;
        for (const ev of list) {
            if (ev.kind === "down") {
                openDown = ev;
                lastRelevant = ev;
            } else if (ev.kind === "up") {
                lastRelevant = ev;
                if (openDown) {
                    openDown._recoveredAt = ev.ms;
                    openDown._mate = ev;
                    ev._downAt = openDown.ms;
                    ev._mate = openDown;
                    openDown = null;
                }
            } else if (ev.kind === "removed") {
                lastRelevant = ev;
                openDown = null;
            }
        }
        if (lastRelevant && lastRelevant.kind === "down") {
            lastRelevant._unrecovered = true;
            count++;
        }
    }
    state.unrecoveredCount = count;
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

// ------------------------- "linha da queda" em foco (hover) -------------------------

function laneY(frac) {
    return (stage.clientHeight - AXIS_H) * frac;
}

function showFocus(ev, animate = true) {
    let downMs;
    let upMs;
    let ongoing = false;

    if (ev.kind === "down") {
        downMs = ev.ms;
        if (ev._recoveredAt != null) {
            upMs = ev._recoveredAt;
        } else {
            upMs = Date.now();
            ongoing = true;
        }
    } else if (ev.kind === "up" && ev._downAt != null) {
        downMs = ev._downAt;
        upMs = ev.ms;
    } else {
        return;
    }

    focusEv = ev;
    const x0 = xOf(downMs);
    const x1 = xOf(upMs);
    const hoveredX = xOf(ev.ms);
    const y0 = laneY(0.24);
    const y1 = laneY(0.56);
    const ymid = laneY(0.42);
    const w = stage.clientWidth;
    const h = stage.clientHeight - AXIS_H;

    focusSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    focusSvg.innerHTML =
        `<line class="tl-focus-guide" x1="${hoveredX}" y1="0" x2="${hoveredX}" y2="${h}"/>` +
        `<path class="tl-focus-path${ongoing ? " ongoing" : ""}" ` +
        `d="M ${x0} ${y0} V ${ymid} H ${x1} V ${y1}"/>`;

    // linha ja nasce inteira (fade de ~90ms via CSS) - nada de "desenhar" lento.
    // Em re-render de pan/zoom (animate=false) tira o fade pra nao piscar.
    if (!animate) {
        const path = focusSvg.querySelector(".tl-focus-path");
        if (path) path.style.animation = ongoing ? "tlDashDrift 0.9s linear infinite" : "none";
    }

    const secs = (upMs - downMs) / 1000;
    let labelText;
    if (ongoing) {
        labelText = `⚠ offline ha ${fmtDuration(secs)}`;
    } else {
        const rec = new Date(upMs);
        labelText = `✔ voltou ${pad(rec.getHours())}:${pad(rec.getMinutes())} · fora ${fmtDuration(secs)}`;
    }
    focusLabel.textContent = labelText;
    focusLabel.classList.toggle("ongoing", ongoing);
    focusLabel.classList.toggle("resolved", !ongoing);
    focusLabel.style.left = (x0 + x1) / 2 + "px";
    focusLabel.style.top = ymid + "px";
    focusLabel.hidden = false;

    stage.classList.add("focusing");
    nodeEls.forEach((el) => el.classList.remove("hi", "mate-hi", "hi-resolved"));
    const self = nodeEls.get(ev.id);
    if (self) self.classList.add("hi", ongoing ? "hi" : "hi-resolved");
    if (ev._mate) {
        const mate = nodeEls.get(ev._mate.id);
        if (mate) mate.classList.add("mate-hi");
    }
}

function hideFocus() {
    focusEv = null;
    focusSvg.innerHTML = "";
    focusLabel.hidden = true;
    stage.classList.remove("focusing");
    nodeEls.forEach((el) => el.classList.remove("hi", "mate-hi", "hi-resolved"));
}

// ------------------------- foco num equipamento na linha do tempo -------------------------

const equipChip = document.getElementById("tl-equip-focus");
const equipChipName = document.getElementById("tl-equip-focus-name");

function focusEquipmentOnTimeline(id, name) {
    if (id == null) return;
    state.focusEquipmentId = id;
    state.focusEquipmentName = name || "Equipamento #" + id;
    equipChipName.textContent = state.focusEquipmentName;
    equipChip.hidden = false;
    fitToEquipment();
    scheduleLayout();
}

function fitToEquipment() {
    const fid = state.focusEquipmentId;
    if (fid == null) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const ev of state.events) {
        if (ev.equipment_id !== fid) continue;
        if (ev.ms < lo) lo = ev.ms;
        if (ev.ms > hi) hi = ev.ms;
    }
    if (!isFinite(lo)) return;
    let span = hi - lo;
    if (span < 10 * 60e3) {
        const c = (lo + hi) / 2;
        lo = c - 30 * 60e3;
        hi = c + 30 * 60e3;
        span = hi - lo;
    }
    const pad = span * 0.12;
    setFollow(false);
    fitRange(lo - pad, hi + pad);
}

function clearEquipmentFocus() {
    state.focusEquipmentId = null;
    state.focusEquipmentName = "";
    equipChip.hidden = true;
    scheduleLayout();
}

if (equipChip) {
    document.getElementById("tl-equip-focus-clear").addEventListener("click", () => {
        if (sidePanel && !sidePanel.hidden) closeEquipmentDetail();
        else clearEquipmentFocus();
    });
}

// ------------------------- nodes + popover -------------------------

function buildNode(ev) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `tl-node k-${ev.kind} lane-${LANE_OF[ev.kind]}`;
    const typeSvg =
        typeof window.deviceIcon === "function"
            ? window.deviceIcon(ev.category, ev.equipment_name)
            : "";
    el.innerHTML =
        `<span class="tl-node-ring"></span>` +
        `<span class="tl-node-core"></span>` +
        `<span class="tl-node-type">${typeSvg}</span>`;
    const enter = () => {
        showPop(ev, el);
        if (ev.kind === "down" || ev.kind === "up") showFocus(ev);
    };
    const leave = () => {
        scheduleHidePop();
        hideFocus();
    };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("focus", enter);
    el.addEventListener("blur", leave);
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
    const eqInfo = equipmentById.get(ev.equipment_id);
    const desc = eqInfo && eqInfo.description;
    if (desc) rows.push(`<div class="tl-pop-row tl-pop-desc">${escapeHtml(desc)}</div>`);
    rows.push(`<div class="tl-pop-row"><b>${escapeHtml(ev.ip || "-")}</b>${ev.category ? " &bull; " + escapeHtml(ev.category) : ""}</div>`);
    rows.push(`<div class="tl-pop-row">${fmtDateTime(ev.ms)}</div>`);
    if (ev.kind === "up" && ev.duration_seconds != null) {
        rows.push(`<div class="tl-pop-row">Queda durou <b>${fmtDuration(ev.duration_seconds)}</b></div>`);
    }
    if (ev.kind === "down") {
        rows.push(
            ev._unrecovered
                ? `<div class="tl-pop-row"><b style="color:var(--tl-red)">&#9888; AINDA OFFLINE</b> &bull; nao voltou</div>`
                : `<div class="tl-pop-row">Ficou <b style="color:var(--tl-red)">OFFLINE</b></div>`
        );
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
    positionPop(el);
}

function positionPop(el) {
    const r = el.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = clamp(left, 10, window.innerWidth - pr.width - 10);
    let top = r.top - pr.height - 12;
    if (top < 10) top = r.bottom + 12;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
}

// ------------------------- marcadores de grupo (cluster) -------------------------

function buildCluster() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tl-node tl-cluster";
    el.innerHTML =
        `<span class="tl-node-ring"></span>` +
        `<span class="tl-node-core"></span>` +
        `<span class="tl-cluster-count"></span>`;
    const enter = () => showClusterPop(el._cluster, el);
    const leave = () => scheduleHidePop();
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("focus", enter);
    el.addEventListener("blur", leave);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        zoomIntoCluster(el._cluster);
    });
    return el;
}

function showClusterPop(c, el) {
    if (!c) return;
    if (popHideTimer) {
        clearTimeout(popHideTimer);
        popHideTimer = null;
    }
    if (pinnedId) return;

    const times = c.members.map((m) => m.ms);
    const a = Math.min(...times);
    const b = Math.max(...times);
    const names = [];
    const seen = new Set();
    for (const m of c.members) {
        const n = m.equipment_name || "Equipamento #" + m.equipment_id;
        if (!seen.has(n)) {
            seen.add(n);
            names.push(n);
        }
    }
    const listRows = names
        .slice(0, 6)
        .map((n) => `<div class="tl-pop-row">&bull; ${escapeHtml(n)}</div>`)
        .join("");
    const moreRow =
        names.length > 6
            ? `<div class="tl-pop-row tl-pop-desc">+${names.length - 6} outros equipamentos</div>`
            : "";

    pop.className = `tl-pop k-${c.kind}`;
    pop.innerHTML =
        `<div class="tl-pop-kind">${c.members.length} &times; ${KIND_LABEL[c.kind]}</div>` +
        `<div class="tl-pop-name">${fmtShort(a)}${a === b ? "" : "  &rarr;  " + fmtShort(b)}</div>` +
        listRows +
        moreRow +
        `<div class="tl-pop-row tl-pop-desc">clique para aproximar</div>`;
    pop.hidden = false;
    positionPop(el);
}

function zoomIntoCluster(c) {
    if (!c) return;
    const times = c.members.map((m) => m.ms);
    let a = Math.min(...times);
    let b = Math.max(...times);
    if (b - a < 60e3) {
        const mid = (a + b) / 2;
        a = mid - 30e3;
        b = mid + 30e3;
    }
    const padMs = (b - a) * 0.25;
    setFollow(false);
    unpin();
    hidePop();
    fitRange(a - padMs, b + padMs);
    clampView();
    scheduleLayout();
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

// ------------------------- aba lateral de detalhes do equipamento -------------------------

const sidePanel = document.getElementById("tl-side");
const detail = {
    event: null,
    window: "24h",
    reqId: 0,
};

// o palco muda de largura ao abrir/fechar a aba -> recalcula o mapa
function afterPanelToggle() {
    requestAnimationFrame(() => {
        state.pxPerMs = clamp(state.pxPerMs, minPxPerMs(), maxPxPerMs());
        if (state.focusEquipmentId != null) fitToEquipment();
        else if (!state.follow) clampView();
        scheduleLayout();
    });
}

function fmtIso(iso) {
    return iso ? fmtDateTime(parseTs(iso)) : "-";
}

function openEquipmentDetail(ev, el) {
    detail.event = ev;
    detail.window = "24h";
    unpin();
    hideFocus();
    // foca esse equipamento na linha do tempo (visivel ao fechar o modal)
    focusEquipmentOnTimeline(ev.equipment_id, ev.equipment_name);
    if (el) {
        pinnedId = ev.id;
        el.classList.add("pinned");
    }
    hidePop();

    document.querySelectorAll("#tlm-windows button").forEach((b) =>
        b.classList.toggle("active", b.dataset.window === "24h")
    );
    document.getElementById("tlm-kind").className =
        "tl-modal-kind k-" + ev.kind + (ev._unrecovered ? " unrecovered" : "");
    document.getElementById("tlm-kind").textContent =
        KIND_LABEL[ev.kind] + " em " + fmtDateTime(ev.ms) +
        (ev._unrecovered ? "  —  AINDA OFFLINE" : "");
    document.getElementById("tlm-name").textContent =
        ev.equipment_name || "Equipamento #" + ev.equipment_id;
    const eqInfo = equipmentById.get(ev.equipment_id);
    const subParts = [ev.ip, ev.category].filter(Boolean).join("  •  ") || "-";
    document.getElementById("tlm-sub").innerHTML =
        escapeHtml(subParts) +
        (eqInfo && eqInfo.description
            ? `<br><span class="tlm-sub-desc">${escapeHtml(eqInfo.description)}</span>`
            : "");
    document.getElementById("tlm-stats").innerHTML =
        `<div class="tl-modal-empty">Carregando disponibilidade…</div>`;
    document.getElementById("tlm-events").innerHTML =
        `<div class="tl-modal-empty">Carregando eventos…</div>`;

    sidePanel.hidden = false;
    afterPanelToggle();
    loadEquipmentDetail();
    loadEquipmentEvents();
}

function closeEquipmentDetail() {
    sidePanel.hidden = true;
    detail.event = null;
    clearEquipmentFocus();
    afterPanelToggle();
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
    hideFocus();
    dragStartX = e.clientX;
    dragStartView = state.viewStartMs;
    stage.classList.add("grabbing");
    stage.setPointerCapture(e.pointerId);
});

stage.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    const dx = e.clientX - dragStartX;
    state.viewStartMs = dragStartView - dx / state.pxPerMs;
    clampView();
    scheduleLayout();
});

// impede arrastar/rolar para bem longe do conteudo (ficar olhando o vazio)
function clampView() {
    const w = stage.clientWidth;
    const spanMs = w / state.pxPerMs;
    let lo = state.boundsFirstMs;
    let hi = Math.max(Date.now(), state.boundsLastMs || 0);
    if (lo == null) lo = Date.now() - RANGE_MS["24h"];
    const padMs = spanMs * 0.2;
    const minStart = lo - padMs;
    const maxStart = hi + padMs - spanMs;
    if (minStart <= maxStart) {
        state.viewStartMs = clamp(state.viewStartMs, minStart, maxStart);
    } else {
        state.viewStartMs = (lo + hi) / 2 - spanMs / 2; // cabe tudo: centraliza
    }
}

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
            // normaliza deltaMode (linha/pagina -> pixels) e nao amplifica
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
            const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            state.viewStartMs += (raw * unit) / state.pxPerMs;
            setFollow(false);
            clampView();
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
    clampView();
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
        clampView();
        scheduleLayout();
    } else if (e.key === "ArrowRight") {
        state.viewStartMs += (stage.clientWidth * 0.15) / state.pxPerMs;
        setFollow(false);
        clampView();
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
        if (!bellPanel.hidden) closeBell();
        else if (!sidePanel.hidden) closeEquipmentDetail();
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

const clusterToggle = document.getElementById("tl-cluster");
if (clusterToggle) {
    state.cluster = clusterToggle.checked;
    clusterToggle.addEventListener("change", (e) => {
        state.cluster = e.target.checked;
        unpin();
        hidePop();
        scheduleLayout();
    });
}

// ------------------------- tamanho dos icones -------------------------

const ICON_SCALE_KEY = "tl:iconScale";
const ICON_SCALE_MIN = 0.7;
const ICON_SCALE_MAX = 1.9;
const ICON_SCALE_STEP = 0.15;
let iconScale = 1;
try {
    const saved = parseFloat(localStorage.getItem(ICON_SCALE_KEY));
    if (saved >= ICON_SCALE_MIN && saved <= ICON_SCALE_MAX) iconScale = saved;
} catch (_) {}

function applyIconScale() {
    stage.style.setProperty("--tl-icon-scale", iconScale.toFixed(2));
    try {
        localStorage.setItem(ICON_SCALE_KEY, String(iconScale));
    } catch (_) {}
    const dec = document.getElementById("tl-icon-dec");
    const inc = document.getElementById("tl-icon-inc");
    if (dec) dec.disabled = iconScale <= ICON_SCALE_MIN + 1e-6;
    if (inc) inc.disabled = iconScale >= ICON_SCALE_MAX - 1e-6;
}

function bumpIconScale(dir) {
    iconScale = clamp(
        Math.round((iconScale + dir * ICON_SCALE_STEP) * 100) / 100,
        ICON_SCALE_MIN,
        ICON_SCALE_MAX
    );
    applyIconScale();
}

applyIconScale();
const iconDec = document.getElementById("tl-icon-dec");
const iconInc = document.getElementById("tl-icon-inc");
if (iconDec) iconDec.addEventListener("click", () => bumpIconScale(-1));
if (iconInc) iconInc.addEventListener("click", () => bumpIconScale(1));

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

async function loadEquipmentIndex() {
    try {
        const list = await fetch("/api/equipments").then((r) => r.json());
        equipmentById = new Map(list.map((e) => [e.id, e]));
    } catch (err) {
        console.error("equipments index:", err);
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
    // pega os mais RECENTES (nao os mais antigos) ao bater no limite: garante
    // que, se uma queda esta carregada, a recuperacao dela (mais nova) tambem
    // esta -> evita marcar como "ainda offline" algo que ja voltou
    params.set("order", "desc");
    params.set("limit", "10000");

    try {
        const list = await fetch("/api/timeline?" + params.toString()).then((r) => r.json());
        state.events = list
            .map((e) => ({ ...e, ms: parseTs(e.ts) }))
            // ordena cronologicamente; `id` (autoincrement) desempata quando
            // dois eventos caem no mesmo milissegundo, garantindo down antes de up
            .sort((a, b) => a.ms - b.ms || a.id - b.id);
        computeEventLinks();
        if (focusEv) focusEv = state.events.find((e) => e.id === focusEv.id) || null;
        notifyNewEvents(!!keepView);
        updateFooter();
        if (!keepView) {
            applyInitialView();
            if (state.focusEquipmentId != null) fitToEquipment();
        } else if (!state.follow) {
            clampView();
        }
        scheduleLayout();
    } catch (err) {
        console.error("events:", err);
    }
}

// ------------------------- notificacoes (sino) -------------------------

function notifyNewEvents(fromPoll) {
    const fresh = [];
    for (const ev of state.events) {
        if (knownEventIds.has(ev.id)) continue;
        knownEventIds.add(ev.id);
        if (notifSeeded && fromPoll) fresh.push(ev);
    }
    notifSeeded = true;
    if (!fresh.length) return;
    fresh.sort((a, b) => b.ms - a.ms); // mais recente primeiro
    for (const ev of fresh) notifItems.unshift({ ev, read: false });
    notifItems = notifItems.slice(0, 50);
    unreadCount = Math.min(99, unreadCount + fresh.length);
    renderBell();
}

function notifExtra(ev) {
    if (ev.kind === "up" && ev.duration_seconds != null) {
        return " · ficou fora " + fmtDuration(ev.duration_seconds);
    }
    if (ev.kind === "down" && ev._unrecovered) return " · ainda offline";
    return "";
}

function renderBell() {
    const hasUnread = unreadCount > 0;
    bellBtn.classList.toggle("has-unread", hasUnread);
    bellBadge.hidden = !hasUnread;
    bellBadge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);

    if (!notifItems.length) {
        bellList.innerHTML = `<div class="tl-bell-empty">Nenhuma movimentacao ainda.</div>`;
        return;
    }
    bellList.innerHTML = notifItems
        .map((it, idx) => {
            const ev = it.ev;
            const name = ev.equipment_name || "Equipamento #" + ev.equipment_id;
            return (
                `<div class="tl-bell-item k-${ev.kind}${it.read ? "" : " unread"}" data-idx="${idx}">` +
                `<span class="tl-bell-dot"></span>` +
                `<div class="tl-bell-body">` +
                `<b>${KIND_LABEL[ev.kind]}</b>` +
                `<span class="tl-bell-name">${escapeHtml(name)}</span>` +
                `<span class="tl-bell-sub">${fmtDateTime(ev.ms)}${notifExtra(ev)}</span>` +
                `</div></div>`
            );
        })
        .join("");
}

function openBell() {
    bellPanel.hidden = false;
    bellBtn.setAttribute("aria-expanded", "true");
    notifItems.forEach((it) => (it.read = true));
    unreadCount = 0;
    renderBell();
}

function closeBell() {
    bellPanel.hidden = true;
    bellBtn.setAttribute("aria-expanded", "false");
}

bellBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (bellPanel.hidden) openBell();
    else closeBell();
});

document.getElementById("tl-bell-clear").addEventListener("click", (e) => {
    e.stopPropagation();
    notifItems = [];
    unreadCount = 0;
    renderBell();
});

bellList.addEventListener("click", (e) => {
    const item = e.target.closest(".tl-bell-item");
    if (!item) return;
    const it = notifItems[+item.dataset.idx];
    if (!it) return;
    closeBell();
    openEquipmentDetail(it.ev);
});

document.addEventListener("click", (e) => {
    if (!bellPanel.hidden && !e.target.closest(".tl-bell-wrap")) closeBell();
});

renderBell();

function updateFooter() {
    const n = state.unrecoveredCount || 0;
    document.getElementById("tl-foot-count").innerHTML =
        `${state.events.length} eventos` +
        (n ? ` <span class="tl-foot-alert">&#9888; ${n} sem retorno</span>` : "");
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

    await Promise.all([loadBounds(), loadCategories(), loadEquipmentIndex()]);
    await loadEvents(false);

    requestAnimationFrame(frameLoop);

    setInterval(async () => {
        await Promise.all([loadBounds(), loadEquipmentIndex()]);
        await loadEvents(true);
    }, POLL_MS);
})();
