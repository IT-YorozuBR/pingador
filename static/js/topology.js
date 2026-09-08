/* ============================================================
   Topologia de Rede - Cytoscape.js sobre os dados que o sistema
   de monitoramento ja produz (GET /api/topology). Sem ping novo.
   ============================================================ */

const POLL_MS = 3000;

const STATUS_CLASS = {
    online: "status-online",
    offline: "status-offline",
    aguardando: "status-waiting",
};

const state = {
    editing: false,
    connecting: false,
    connectSource: null,
    dirtyPositions: false,
    devicesByIp: new Map(),
    prevStatus: new Map(),
    search: "",
    filterStatus: "",
    filterType: "",
    lastRefreshAt: 0,
    failStreak: 0,
    pollInFlight: false,
};

let cy = null;
let saveTimer = null;
let toastTimer = null;

// ------------------------- helpers -------------------------

function iconFor(d) {
    const s = ((d.category || "") + " " + (d.name || "")).toLowerCase();
    if (/firewall|fortigate|palo alto|sophos|\bfw\b|\butm\b/.test(s)) return "🔥"; // fire
    if (/roteador|router|mikrotik|gateway|\brb\d/.test(s)) return "🌐"; // globe
    if (/switch|\bsw[-\s]?\d|catalyst/.test(s)) return "🔀"; // shuffle
    if (/servidor|server|\bsrv\b|proxmox|zabbix|\bnas\b|\bilo\b|windows server|hyper-?v|vmware|esxi/.test(s)) return "🖥️"; // desktop computer
    if (/access ?point|\bap[-\s]?\d|\bap\b|unifi|wi-?fi|wireless/.test(s)) return "📡"; // satellite antenna
    if (/impressora|printer|zebra|\bsato\b|kyocera|multifuncional/.test(s)) return "🖨️"; // printer
    if (/c[aâ]mera|\bcam\b|\bnvr\b|\bdvr\b|\bnvd\b|mhdx|intelbras cam/.test(s)) return "📷"; // camera
    if (/facial|catraca|control ?id|ponto|controle de acesso|biometr/.test(s)) return "🔒"; // lock
    if (/\bpc[-\s]?\d|desktop|computador|note(book)?|\bnote[-\s]?\d|workstation/.test(s)) return "💻"; // laptop

    const c = (d.category || "").toLowerCase();
    if (c.includes("servidor")) return "🖥️";
    if (c.includes("access")) return "📡";
    if (c.includes("câmera") || c.includes("camera")) return "📷";
    if (c.includes("impressora")) return "🖨️";
    if (c.includes("acesso")) return "🔒";
    if (c.includes("rede")) return "🔀";
    return "🔷"; // generic
}

function statusLine(d) {
    if (d.status === "online") {
        return "🟢 ONLINE" + (d.response_time_ms != null ? "  " + d.response_time_ms + " ms" : "");
    }
    if (d.status === "offline") return "🔴 OFFLINE";
    return "⚪ AGUARDANDO";
}

function nodeLabel(d) {
    return `${iconFor(d)}  ${d.name}\n${d.ip}\n${statusLine(d)}`;
}

function fmtTime(iso) {
    if (!iso) return "-";
    const dt = new Date(iso);
    return dt.toLocaleTimeString("pt-BR");
}

function toast(msg, isErr) {
    const el = document.getElementById("topo-toast");
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ------------------------- cytoscape -------------------------

const CY_STYLE = [
    {
        selector: "node",
        style: {
            "background-color": "#0e1712",
            "border-width": 2,
            "border-color": "#2a3d2e",
            shape: "round-rectangle",
            label: "data(label)",
            color: "#d8f5df",
            "font-family": "JetBrains Mono, Consolas, monospace",
            "font-size": 11,
            "line-height": 1.4,
            "text-wrap": "wrap",
            "text-max-width": 240,
            "text-valign": "center",
            "text-halign": "center",
            padding: "12px",
            width: "label",
            height: "label",
        },
    },
    { selector: "node.status-online", style: { "border-color": "#34d67a" } },
    { selector: "node.status-offline", style: { "border-color": "#f04952", "background-color": "#1a1012" } },
    { selector: "node.status-waiting", style: { "border-color": "#6f8a78" } },
    { selector: "node:selected", style: { "border-color": "#3dd6e0", "border-width": 3 } },
    { selector: "node.search-hit", style: { "border-color": "#3dd6e0", "border-width": 3, "background-color": "#12211d" } },
    { selector: "node.connect-source", style: { "border-color": "#3dd6e0", "border-width": 4, "border-style": "double" } },
    { selector: "node.dim", style: { opacity: 0.16 } },

    {
        selector: "edge",
        style: {
            width: 2,
            "line-color": "#2c3f31",
            "curve-style": "taxi",
            "taxi-direction": "auto",
            "taxi-turn": "40%",
            "taxi-turn-min-distance": 12,
            "target-arrow-shape": "none",
        },
    },
    { selector: "edge.conn-degraded", style: { "line-color": "#f2994a", "line-style": "dashed" } },
    { selector: "edge:selected", style: { "line-color": "#3dd6e0", width: 3 } },
    { selector: "edge.dim", style: { opacity: 0.1 } },

    { selector: "node.pulse-change", style: { "border-color": "#3dd6e0", "border-width": 4 } },
];

function buildElements(data) {
    const nodes = data.devices.map((d) => {
        const el = {
            data: {
                id: d.ip,
                ip: d.ip,
                name: d.name,
                label: nodeLabel(d),
            },
            classes: STATUS_CLASS[d.status] || "status-waiting",
        };
        if (d.x != null && d.y != null) el.position = { x: d.x, y: d.y };
        return el;
    });
    const edges = data.connections.map((c) => ({
        data: { id: "c" + c.id, connId: c.id, source: c.source_ip, target: c.target_ip },
    }));
    return { nodes, edges };
}

function allNodesPositioned(data) {
    return data.devices.length > 0 && data.devices.every((d) => d.x != null && d.y != null);
}

function runAutoLayout(animate, save) {
    if (!cy || cy.nodes().length === 0) return;
    const hasEdges = cy.edges().length > 0;
    const roots = cy.nodes().filter((n) => n.indegree(false) === 0);
    const opts = hasEdges
        ? {
              name: "breadthfirst",
              directed: true,
              roots: roots.length ? roots : undefined,
              spacingFactor: 1.55,
              padding: 50,
              avoidOverlap: true,
              animate: !!animate,
              animationDuration: 380,
              fit: true,
          }
        : {
              name: "grid",
              padding: 50,
              avoidOverlap: true,
              animate: !!animate,
              animationDuration: 380,
              fit: true,
          };
    const layout = cy.layout(opts);
    if (save) layout.one("layoutstop", savePositions);
    layout.run();
}

// ------------------------- posicoes -------------------------

function collectPositions() {
    const positions = {};
    cy.nodes().forEach((n) => {
        const p = n.position();
        positions[n.id()] = { x: Math.round(p.x), y: Math.round(p.y) };
    });
    return positions;
}

function savePositions() {
    if (!cy) return;
    fetch("/api/topology/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: collectPositions() }),
    }).catch((err) => console.error("layout save:", err));
    state.dirtyPositions = false;
}

function scheduleSavePositions() {
    state.dirtyPositions = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePositions, 800);
}

// ------------------------- edicao -------------------------

function setEditing(on) {
    state.editing = on;
    document.getElementById("topo-editbar").hidden = !on;
    const btn = document.getElementById("topo-edit");
    btn.textContent = on ? "Concluir edicao" : "Editar topologia";
    btn.classList.toggle("btn-primary", !on);
    btn.classList.toggle("btn-secondary", on);

    if (on) {
        cy.nodes().grabify();
    } else {
        cy.nodes().ungrabify();
        disarmConnect();
        if (state.dirtyPositions) savePositions();
        cy.$(":selected").unselect();
    }
}

function armConnect() {
    state.connecting = true;
    state.connectSource = null;
    document.getElementById("topo-connect").classList.add("armed");
    document.getElementById("topo-edit-hint").textContent =
        "clique no equipamento de CIMA (mais proximo do nucleo) e depois no de baixo. Esc cancela.";
}

function disarmConnect() {
    state.connecting = false;
    if (state.connectSource) {
        cy.$id(state.connectSource).removeClass("connect-source");
        state.connectSource = null;
    }
    document.getElementById("topo-connect").classList.remove("armed");
    document.getElementById("topo-edit-hint").textContent =
        'arraste os nos • "Conectar": clique no equipamento de cima e depois no de baixo';
}

async function createConnection(srcIp, tgtIp) {
    try {
        const res = await fetch("/api/topology/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_ip: srcIp, target_ip: tgtIp }),
        });
        const data = await res.json();
        if (!res.ok) {
            toast(data.error || "Falha ao criar conexao.", true);
            return;
        }
        const edgeId = "c" + data.id;
        if (!cy.$id(edgeId).length) {
            cy.add({ data: { id: edgeId, connId: data.id, source: data.source_ip, target: data.target_ip } });
            refreshDegraded();
        }
        toast("Conexao criada.");
    } catch (err) {
        console.error("create connection:", err);
        toast("Falha ao criar conexao.", true);
    }
}

async function deleteSelectedConnections() {
    const edges = cy.edges(":selected");
    if (edges.length === 0) {
        toast("Selecione uma conexao (clique na linha) para remover.", true);
        return;
    }
    for (const edge of edges) {
        const id = edge.data("connId");
        try {
            const res = await fetch("/api/topology/connections/" + id, { method: "DELETE" });
            if (res.ok) edge.remove();
        } catch (err) {
            console.error("delete connection:", err);
        }
    }
    toast("Conexao removida.");
}

// ------------------------- filtros / busca -------------------------

function deviceMatches(d) {
    if (state.filterStatus && d.status !== state.filterStatus) return false;
    if (state.filterType && d.category !== state.filterType) return false;
    if (state.search) {
        const q = state.search.toLowerCase();
        const hay = (d.name + " " + d.ip + " " + (d.category || "") + " " + (d.description || "")).toLowerCase();
        if (!hay.includes(q)) return false;
    }
    return true;
}

function applyFilters(centerOnHit) {
    if (!cy) return;
    const hasQuery = state.search || state.filterStatus || state.filterType;
    let firstHit = null;

    cy.batch(() => {
        cy.nodes().forEach((n) => {
            const d = state.devicesByIp.get(n.id());
            if (!d) return;
            const ok = deviceMatches(d);
            n.toggleClass("dim", hasQuery && !ok);
            const isSearchHit = state.search && ok;
            n.toggleClass("search-hit", !!isSearchHit);
            if (isSearchHit && !firstHit) firstHit = n;
        });
        cy.edges().forEach((e) => {
            e.toggleClass("dim", e.source().hasClass("dim") || e.target().hasClass("dim"));
        });
    });

    if (firstHit && centerOnHit) {
        cy.animate({ center: { eles: firstHit }, zoom: Math.max(cy.zoom(), 1) }, { duration: 260 });
    }
}

// ------------------------- painel lateral -------------------------

function openSide(ip) {
    const d = state.devicesByIp.get(ip);
    if (!d) return;
    document.getElementById("ts-name").textContent = `${iconFor(d)}  ${d.name}`;
    document.getElementById("ts-type").textContent = d.category || "-";
    document.getElementById("ts-ip").textContent = d.ip;
    document.getElementById("ts-status").textContent = (d.status || "-").toUpperCase();
    document.getElementById("ts-latency").textContent =
        d.status === "online" && d.response_time_ms != null ? d.response_time_ms + " ms" : d.status === "offline" ? "OFFLINE" : "-";
    document.getElementById("ts-checked").textContent = fmtTime(d.last_checked);
    document.getElementById("ts-desc").textContent = d.description || "-";
    document.getElementById("topo-side").hidden = false;
}

function closeSide() {
    document.getElementById("topo-side").hidden = true;
}

// ------------------------- atualizacao de status -------------------------

function refreshDegraded() {
    cy.edges().forEach((e) => {
        const off = e.source().hasClass("status-offline") || e.target().hasClass("status-offline");
        e.toggleClass("conn-degraded", off);
    });
}

function updateSummary(sum) {
    document.getElementById("sum-total").textContent = sum.total;
    document.getElementById("sum-online").textContent = sum.online;
    document.getElementById("sum-offline").textContent = sum.offline;
}

function reconcile(data) {
    if (!data || !Array.isArray(data.devices)) return;
    state.devicesByIp = new Map(data.devices.map((d) => [d.ip, d]));
    if (data.summary) updateSummary(data.summary);

    const seenNodes = new Set();
    cy.batch(() => {
        // nos: adiciona/atualiza
        data.devices.forEach((d) => {
            seenNodes.add(d.ip);
            let n = cy.$id(d.ip);
            if (n.length === 0) {
                const add = { group: "nodes", data: { id: d.ip, ip: d.ip, name: d.name, label: nodeLabel(d) } };
                if (d.x != null && d.y != null) add.position = { x: d.x, y: d.y };
                else {
                    const ext = cy.extent();
                    add.position = { x: (ext.x1 + ext.x2) / 2 + (Math.random() * 120 - 60), y: (ext.y1 + ext.y2) / 2 + (Math.random() * 120 - 60) };
                }
                n = cy.add(add);
                if (state.editing) n.grabify();
                else n.ungrabify();
            } else {
                n.data("label", nodeLabel(d));
                n.data("name", d.name);
            }
            ["status-online", "status-offline", "status-waiting"].forEach((c) => n.removeClass(c));
            n.addClass(STATUS_CLASS[d.status] || "status-waiting");

            // pisca o no quando o status muda de um poll para o outro
            const prev = state.prevStatus.get(d.ip);
            if (prev !== undefined && prev !== d.status) {
                const nn = n;
                nn.addClass("pulse-change");
                setTimeout(() => nn.removeClass("pulse-change"), 1000);
            }
            state.prevStatus.set(d.ip, d.status);
        });
        // nos que sumiram do sistema
        cy.nodes().forEach((n) => {
            if (!seenNodes.has(n.id())) n.remove();
        });

        // arestas: adiciona/remove conforme conexoes vindas do backend
        const seenEdges = new Set();
        data.connections.forEach((c) => {
            const id = "c" + c.id;
            seenEdges.add(id);
            if (cy.$id(id).length === 0 && cy.$id(c.source_ip).length && cy.$id(c.target_ip).length) {
                cy.add({ group: "edges", data: { id, connId: c.id, source: c.source_ip, target: c.target_ip } });
            }
        });
        cy.edges().forEach((e) => {
            if (!seenEdges.has(e.id())) e.remove();
        });
    });

    refreshDegraded();
    applyFilters(false);
}

async function refresh() {
    if (state.pollInFlight) return;
    state.pollInFlight = true;
    try {
        const res = await fetch("/api/topology", { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        try {
            reconcile(data);
        } catch (e) {
            // uma falha ao renderizar nao deve parecer queda de rede
            console.error("topology reconcile:", e);
        }
        state.lastRefreshAt = Date.now();
        state.failStreak = 0;
        pingIndicator();
    } catch (err) {
        state.failStreak++;
        console.error("topology refresh:", err);
    } finally {
        state.pollInFlight = false;
        updateUpdatedLabel();
    }
}

function pingIndicator() {
    const el = document.getElementById("topo-updated");
    el.classList.remove("pinged");
    void el.offsetWidth; // reinicia a animacao
    el.classList.add("pinged");
    setTimeout(() => el.classList.remove("pinged"), 600);
}

function updateUpdatedLabel() {
    const el = document.getElementById("topo-updated");
    const txt = document.getElementById("topo-updated-txt");
    let cls = "";
    if (!state.lastRefreshAt) {
        cls = "err";
        txt.textContent = state.failStreak ? "sem conexao" : "conectando...";
    } else {
        const secs = Math.round((Date.now() - state.lastRefreshAt) / 1000);
        if (state.failStreak >= 2) {
            cls = "err";
            txt.textContent = `sem conexao (ha ${secs}s)`;
        } else if (secs <= 4) {
            txt.textContent = "atualizado agora";
        } else if (secs < 20) {
            txt.textContent = `atualizado ha ${secs}s`;
        } else {
            cls = "stale";
            txt.textContent = `atualizado ha ${secs}s`;
        }
    }
    el.classList.toggle("err", cls === "err");
    el.classList.toggle("stale", cls === "stale");
}

// ------------------------- init -------------------------

async function init() {
    let data;
    try {
        data = await fetch("/api/topology").then((r) => r.json());
    } catch (err) {
        console.error("topology load:", err);
        return;
    }

    state.devicesByIp = new Map(data.devices.map((d) => [d.ip, d]));
    data.devices.forEach((d) => state.prevStatus.set(d.ip, d.status));
    updateSummary(data.summary);
    state.lastRefreshAt = Date.now();
    document.getElementById("topo-empty").hidden = data.devices.length > 0;

    cy = cytoscape({
        container: document.getElementById("topo-cy"),
        elements: buildElements(data),
        style: CY_STYLE,
        layout: { name: "preset" },
        wheelSensitivity: 0.2,
        minZoom: 0.15,
        maxZoom: 3,
        boxSelectionEnabled: false,
        selectionType: "single",
    });

    cy.nodes().ungrabify();

    // Polling ligado O QUANTO ANTES: se qualquer coisa abaixo lancar excecao,
    // a atualizacao automatica continua funcionando mesmo assim.
    updateUpdatedLabel();
    setInterval(updateUpdatedLabel, 1000);
    setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refresh();
    });
    window.addEventListener("focus", refresh);

    try {
        if (!allNodesPositioned(data)) {
            runAutoLayout(false, false);
        } else {
            cy.fit(cy.elements(), 60);
        }
        refreshDegraded();
    } catch (err) {
        console.error("topology layout inicial:", err);
    }

    // ---- eventos ----
    cy.on("tap", "node", (evt) => {
        const node = evt.target;
        if (state.connecting) {
            if (!state.connectSource) {
                state.connectSource = node.id();
                node.addClass("connect-source");
            } else if (state.connectSource !== node.id()) {
                const src = state.connectSource;
                cy.$id(src).removeClass("connect-source");
                state.connectSource = null;
                createConnection(src, node.id());
            }
            return;
        }
        openSide(node.id());
    });

    cy.on("tap", (evt) => {
        if (evt.target === cy) {
            if (state.connecting && state.connectSource) {
                cy.$id(state.connectSource).removeClass("connect-source");
                state.connectSource = null;
            }
            closeSide();
        }
    });

    cy.on("dragfree", "node", () => {
        if (state.editing) scheduleSavePositions();
    });

    // ---- controles de zoom ----
    const zoomBy = (factor) =>
        cy.zoom({
            level: cy.zoom() * factor,
            renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
        });
    document.getElementById("topo-zoom-in").addEventListener("click", () => zoomBy(1.25));
    document.getElementById("topo-zoom-out").addEventListener("click", () => zoomBy(0.8));
    document.getElementById("topo-fit").addEventListener("click", () => cy.animate({ fit: { eles: cy.elements(), padding: 60 } }, { duration: 200 }));

    // ---- barra de edicao ----
    document.getElementById("topo-edit").addEventListener("click", () => setEditing(!state.editing));
    document.getElementById("topo-connect").addEventListener("click", () => (state.connecting ? disarmConnect() : armConnect()));
    document.getElementById("topo-del-conn").addEventListener("click", deleteSelectedConnections);
    document.getElementById("topo-arrange").addEventListener("click", () => {
        runAutoLayout(true, true);
        toast("Reorganizado.");
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, select, textarea")) return;
        if (e.key === "Escape") {
            if (state.connecting) disarmConnect();
            else closeSide();
        } else if ((e.key === "Delete" || e.key === "Backspace") && state.editing) {
            deleteSelectedConnections();
        }
    });

    // ---- busca / filtros ----
    let searchTimer = null;
    document.getElementById("topo-search").addEventListener("input", (e) => {
        state.search = e.target.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyFilters(true), 180);
    });
    document.getElementById("topo-filter-status").addEventListener("change", (e) => {
        state.filterStatus = e.target.value;
        applyFilters(true);
    });
    document.getElementById("topo-filter-type").addEventListener("change", (e) => {
        state.filterType = e.target.value;
        applyFilters(true);
    });

    document.getElementById("ts-close").addEventListener("click", closeSide);

    // tipos disponiveis (categoria do sistema)
    try {
        const cats = await fetch("/api/categories").then((r) => r.json());
        const sel = document.getElementById("topo-filter-type");
        sel.innerHTML =
            `<option value="">Todos os tipos</option>` +
            cats.map((c) => `<option value="${c.replace(/"/g, "&quot;")}">${c}</option>`).join("");
    } catch (_) {}
}

init();
