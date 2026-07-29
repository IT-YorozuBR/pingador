"""
Pingador - MVP de monitoramento de equipamentos por IP.

Aplicacao Flask simples, dados em memoria (ver storage.py), com
monitoramento automatico rodando em background (ver monitor.py).
"""
from flask import Flask, jsonify, render_template, request

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


# ---------------- API: equipamentos ----------------

@app.route("/api/equipments", methods=["GET"])
def list_equipments():
    category = request.args.get("category")
    equipments = store.list_equipments()
    if category:
        equipments = [eq for eq in equipments if eq.category == category]
    data = []
    for eq in equipments:
        d = eq.to_dict()
        d["events_count"] = len(store.list_events(eq.id, limit=10_000))
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
