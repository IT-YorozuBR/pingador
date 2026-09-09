/* ============================================================
   Icones por tipo de equipamento (SVG inline, sem emoji).
   Usa a mesma heuristica de categoria/nome da topologia.
   Exposto como window.deviceIcon(category, name) -> string SVG.
   ============================================================ */
(function () {
    // cada entrada: { test: regex sobre "categoria nome", svg: miolo do <svg> }
    const RULES = [
        {
            key: "firewall",
            test: /firewall|fortigate|palo alto|sophos|\bfw\b|\butm\b/,
            // parede de tijolos
            svg: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M3 16h18M9 4v6M15 10v6M9 16v4M15 4v6"/>',
        },
        {
            key: "router",
            test: /roteador|router|mikrotik|gateway|\brb\d/,
            // globo
            svg: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
        },
        {
            key: "switch",
            test: /switch|\bsw[-\s]?\d|catalyst/,
            // switch de rede com portas
            svg: '<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2"/>',
        },
        {
            key: "server",
            test: /servidor|server|\bsrv\b|proxmox|zabbix|\bnas\b|\bilo\b|windows server|hyper-?v|vmware|esxi/,
            // rack de servidores
            svg: '<rect x="4" y="3" width="16" height="8" rx="1"/><rect x="4" y="13" width="16" height="8" rx="1"/><path d="M7 7h2M7 17h2"/>',
        },
        {
            key: "ap",
            test: /access ?point|\bap[-\s]?\d|\bap\b|unifi|wi-?fi|wireless/,
            // ondas de wi-fi
            svg: '<path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
        },
        {
            key: "printer",
            test: /impressora|printer|zebra|\bsato\b|kyocera|multifuncional/,
            svg: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
        },
        {
            key: "camera",
            test: /c[aâ]mera|\bcam\b|\bnvr\b|\bdvr\b|\bnvd\b|mhdx|intelbras cam/,
            // camera de video
            svg: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
        },
        {
            key: "access-control",
            test: /facial|catraca|control ?id|ponto|controle de acesso|biometr/,
            // cadeado
            svg: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        },
        {
            key: "pc",
            test: /\bpc[-\s]?\d|desktop|computador|note(book)?|\bnote[-\s]?\d|workstation/,
            // monitor
            svg: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
        },
    ];

    // fallback por palavra na categoria (espelha topology.js)
    const CATEGORY_FALLBACK = [
        { test: /servidor/, key: "server" },
        { test: /access/, key: "ap" },
        { test: /c[aâ]mera|camera/, key: "camera" },
        { test: /impressora/, key: "printer" },
        { test: /acesso/, key: "access-control" },
        { test: /rede/, key: "switch" },
    ];

    const GENERIC = '<path d="M12 2l10 10-10 10L2 12 12 2z"/>';
    const SVG_BY_KEY = Object.fromEntries(RULES.map((r) => [r.key, r.svg]));

    function pickKey(category, name) {
        const s = ((category || "") + " " + (name || "")).toLowerCase();
        for (const r of RULES) {
            if (r.test.test(s)) return r.key;
        }
        const c = (category || "").toLowerCase();
        for (const f of CATEGORY_FALLBACK) {
            if (f.test.test(c)) return f.key;
        }
        return "generic";
    }

    function deviceIconKey(category, name) {
        return pickKey(category, name);
    }

    function deviceIcon(category, name) {
        const key = pickKey(category, name);
        const inner = key === "generic" ? GENERIC : SVG_BY_KEY[key];
        return (
            '<svg class="device-icon" viewBox="0 0 24 24" width="24" height="24" ' +
            'fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" ' +
            'data-type="' + key + '" aria-hidden="true">' + inner + "</svg>"
        );
    }

    window.deviceIcon = deviceIcon;
    window.deviceIconKey = deviceIconKey;
})();
