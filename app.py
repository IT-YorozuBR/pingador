"""
Pingador - MVP de monitoramento de equipamentos por IP.

Aplicacao Flask simples, dados em memoria (ver storage.py), com
monitoramento automatico rodando em background (ver monitor.py).
"""
from flask import Flask, jsonify, render_template, request

import db
from excel_sync import EXCEL_PATH, start_excel_watcher, sync_now
from models import STATUS_ONLINE, STATUS_OFFLINE
from monitor import start_scheduler
from storage import store, ValidationError

app = Flask(__name__)

# Inicia o monitoramento em background e o watcher da planilha assim que o
# modulo e carregado (tanto em `python app.py` quanto sob um servidor WSGI
# como o gunicorn, que importa o modulo sem passar pelo bloco __main__).
start_scheduler()
start_excel_watcher()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/timeline")
def timeline_page():
    return render_template("timeline.html")


@app.route("/topology")
def topology_page():
    return render_template("topology.html")


# ---------------- API: equipamentos ----------------

@app.route("/api/equipments", methods=["GET"])
def list_equipments():
    category = request.args.get("category")
    equipments = store.list_equipments()
    if category:
        equipments = [eq for eq in equipments if eq.category == category]
    states = {s["equipment_id"]: s for s in db.list_states()}
    data = []
    for eq in equipments:
        d = eq.to_dict()
        d["events_count"] = len(store.list_events(eq.id, limit=10_000))
        # snapshot persistido (sobrevive a reinicializacao)
        st = states.get(eq.id, {})
        d["last_success_at"] = st.get("last_success_at")
        d["last_failure_at"] = st.get("last_failure_at")
        data.append(d)
    # ordena por nome para exibicao estavel
    data.sort(key=lambda e: e["name"].lower())
    return jsonify(data)


@app.route("/api/categories", methods=["GET"])
def list_categories():
    return jsonify(store.list_categories())


@app.route("/api/equipments", methods=["POST"])
def create_equipment():
    payload = request.get_json(silent=True) or {}
    try:
        eq = store.add_equipment(
            ip=payload.get("ip"),
            name=payload.get("name"),
            description=payload.get("description"),
            frequency=payload.get("frequency"),
        )
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(eq.to_dict()), 201


@app.route("/api/equipments/<int:equipment_id>", methods=["DELETE"])
def delete_equipment(equipment_id):
    ok = store.remove_equipment(equipment_id)
    if not ok:
        return jsonify({"error": "Equipamento nao encontrado."}), 404
    return jsonify({"ok": True})


@app.route("/api/equipments/<int:equipment_id>/toggle", methods=["POST"])
def toggle_equipment(equipment_id):
    eq = store.toggle_monitoring(equipment_id)
    if not eq:
        return jsonify({"error": "Equipamento nao encontrado."}), 404
    return jsonify(eq.to_dict())


# ---------------- API: historico / eventos ----------------

@app.route("/api/events", methods=["GET"])
def list_events():
    equipment_id = request.args.get("equipment_id", type=int)
    limit = request.args.get("limit", default=200, type=int)
    events = store.list_events(equipment_id=equipment_id, limit=limit)
    return jsonify([e.to_dict() for e in events])


@app.route("/api/ping-history", methods=["GET"])
def ping_history():
    """Historico curto de amostras de ping por equipamento (monitor de pulso)."""
    equipment_id = request.args.get("equipment_id", type=int)
    return jsonify(store.get_ping_history(equipment_id=equipment_id))


# ---------------- API: sincronizacao com a planilha de inventario ----------------

@app.route("/api/excel-sync", methods=["POST"])
def excel_sync_now():
    try:
        result = sync_now()
    except FileNotFoundError:
        return jsonify({"error": f"Arquivo nao encontrado: {EXCEL_PATH}"}), 404
    except Exception as e:
        return jsonify({"error": f"Falha ao ler a planilha: {e}"}), 400
    return jsonify(result)


# ---------------- API: disponibilidade (SQLite) ----------------

@app.route("/api/availability", methods=["GET"])
def availability():
    """
    Resumo de disponibilidade a partir do historico persistido em SQLite.

    - com equipment_id: retorna o resumo daquele equipamento.
    - sem equipment_id: retorna a lista de todos os equipamentos.

    Parametro `window`: 1h, 6h, 12h, 24h (padrao), 48h, 7d, 14d, 30d, all.
    """
    window = request.args.get("window", default="24h")
    equipment_id = request.args.get("equipment_id", type=int)

    if equipment_id is not None:
        data = db.get_availability(equipment_id, window)
        eq = store.get_equipment(equipment_id)
        data["equipment_id"] = equipment_id
        data["name"] = eq.name if eq else None
        return jsonify(data)

    result = []
    for eq in store.list_equipments():
        data = db.get_availability(eq.id, window)
        data["equipment_id"] = eq.id
        data["name"] = eq.name
        data["ip"] = eq.ip
        data["category"] = eq.category
        data["status"] = eq.status
        result.append(data)
    result.sort(key=lambda d: (d["uptime_percent"] is None, d["uptime_percent"] or 0))
    return jsonify(result)


@app.route("/api/availability/series", methods=["GET"])
def availability_series():
    """Serie temporal (por hora ou por dia) para o grafico de disponibilidade."""
    equipment_id = request.args.get("equipment_id", type=int)
    if equipment_id is None:
        return jsonify({"error": "equipment_id e obrigatorio."}), 400
    window = request.args.get("window", default="24h")
    bucket = request.args.get("bucket")  # "hour" | "day" | None (auto)
    return jsonify(db.get_availability_series(equipment_id, window, bucket))


# ---------------- API: linha do tempo de eventos ----------------

@app.route("/api/timeline", methods=["GET"])
def api_timeline():
    """
    Eventos (quedas / recuperacoes / cadastros / remocoes) persistidos em
    SQLite, para a pagina dedicada de linha do tempo.

    Filtros (querystring, todos opcionais):
      - since / until : ISO datetime (limites da janela)
      - kinds         : lista separada por virgula (down,up,created,removed)
      - equipment_id  : int
      - category      : base/categoria
      - search        : casa com nome do equipamento ou IP
      - limit         : maximo de eventos (padrao 3000)
      - order         : asc (padrao) | desc
    """
    kinds_raw = request.args.get("kinds")
    kinds = [k.strip() for k in kinds_raw.split(",") if k.strip()] if kinds_raw else None
    events = db.query_events(
        since=request.args.get("since"),
        until=request.args.get("until"),
        kinds=kinds,
        equipment_id=request.args.get("equipment_id", type=int),
        category=request.args.get("category"),
        search=request.args.get("search"),
        limit=request.args.get("limit", default=3000, type=int),
        order=request.args.get("order", default="asc"),
    )
    return jsonify(events)


@app.route("/api/timeline/bounds", methods=["GET"])
def api_timeline_bounds():
    """Extremos + contagem por tipo, usados para calibrar o zoom inicial."""
    return jsonify(db.events_bounds())


# ---------------- API: topologia de rede ----------------

@app.route("/api/topology", methods=["GET"])
def api_topology():
    """
    Alimenta a pagina de Topologia. NAO executa ping: apenas observa o estado
    que o monitoramento ja produz (mesma fonte do dashboard).

    - devices: os mesmos equipamentos de store.list_equipments(), com a posicao
      salva (por IP) quando houver.
    - connections: relacionamentos cadastrados pelo usuario, filtrando os que
      apontam para equipamentos que nao existem mais.
    - summary: total / online / offline (mesma contagem do /api/dashboard).
    """
    equipments = store.list_equipments()
    layout = db.get_device_layout()
    present_ips = set()
    devices = []
    for eq in equipments:
        present_ips.add(eq.ip)
        pos = layout.get(eq.ip)
        devices.append(
            {
                "id": eq.id,
                "ip": eq.ip,
                "name": eq.name,
                "category": eq.category,
                "description": eq.description,
                "status": eq.status,
                "monitoring_active": eq.monitoring_active,
                "response_time_ms": eq.last_response_time_ms,
                "last_checked": eq.last_checked.isoformat() if eq.last_checked else None,
                "x": pos["x"] if pos else None,
                "y": pos["y"] if pos else None,
            }
        )

    connections = [
        c
        for c in db.list_connections()
        if c["source_ip"] in present_ips and c["target_ip"] in present_ips
    ]

    total = len(equipments)
    online = sum(1 for e in equipments if e.status == STATUS_ONLINE)
    offline = sum(1 for e in equipments if e.status == STATUS_OFFLINE)

    return jsonify(
        {
            "devices": devices,
            "connections": connections,
            "summary": {
                "total": total,
                "online": online,
                "offline": offline,
                "waiting": total - online - offline,
            },
        }
    )


@app.route("/api/topology/layout", methods=["POST"])
def api_topology_layout():
    """Salva as posicoes dos nos. Body: { "positions": { "<ip>": {"x":..,"y":..} } }."""
    payload = request.get_json(silent=True) or {}
    positions = payload.get("positions")
    if not isinstance(positions, dict):
        return jsonify({"error": "positions deve ser um objeto { ip: {x, y} }."}), 400
    saved = db.save_device_layout(positions)
    return jsonify({"saved": saved})


@app.route("/api/topology/connections", methods=["POST"])
def api_topology_add_connection():
    payload = request.get_json(silent=True) or {}
    src = (payload.get("source_ip") or "").strip()
    tgt = (payload.get("target_ip") or "").strip()
    if not src or not tgt or src == tgt:
        return jsonify({"error": "source_ip e target_ip distintos sao obrigatorios."}), 400
    result = db.add_connection(src, tgt)
    if not result:
        return jsonify({"error": "Nao foi possivel criar a conexao."}), 400
    return jsonify(result), 201


@app.route("/api/topology/connections/<int:conn_id>", methods=["DELETE"])
def api_topology_delete_connection(conn_id):
    if not db.delete_connection(conn_id):
        return jsonify({"error": "Conexao nao encontrada."}), 404
    return jsonify({"ok": True})


# ---------------- API: dashboard ----------------

@app.route("/api/dashboard", methods=["GET"])
def dashboard_summary():
    equipments = store.list_equipments()
    total = len(equipments)
    online = sum(1 for e in equipments if e.status == STATUS_ONLINE)
    offline = sum(1 for e in equipments if e.status == STATUS_OFFLINE)
    waiting = total - online - offline
    availability = round((online / total) * 100, 1) if total else 0.0

    # quedas por equipamento (para grafico de barras)
    downs_by_equipment = [
        {"name": eq.name, "down_count": eq.down_count} for eq in equipments
    ]

    # ultima queda / ultima recuperacao global
    all_events = store.list_events(limit=10_000)
    last_down = next((e for e in all_events if e.down_at), None)
    last_up = next((e for e in all_events if e.up_at), None)

    return jsonify(
        {
            "total": total,
            "online": online,
            "offline": offline,
            "waiting": waiting,
            "availability_percent": availability,
            "downs_by_equipment": downs_by_equipment,
            "last_down": last_down.to_dict() if last_down else None,
            "last_up": last_up.to_dict() if last_up else None,
        }
    )


if __name__ == "__main__":
    import os

    port = int(os.environ.get("PINGADOR_PORT", 8000))
    debug = os.environ.get("PINGADOR_DEBUG", "false").lower() == "true"
    app.run(debug=debug, use_reloader=False, host="0.0.0.0", port=port)
