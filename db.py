"""
Camada de persistencia em SQLite.

O restante da aplicacao continua trabalhando com o `store` em memoria
(storage.py) para o estado "ao vivo". Este modulo guarda, em disco, o
historico de todas as verificacoes de ping para permitir:

- registrar a ultima vez que cada equipamento respondeu com sucesso
  (sobrevive a reinicializacao do processo/container);
- montar graficos de disponibilidade (percentual de tempo de pe) por
  janela de tempo (24h / 7d / 30d).

Optamos por SQLite puro (stdlib `sqlite3`) para nao adicionar dependencia.
Uma unica conexao compartilhada, protegida por lock, ja da conta do volume
de escrita deste app (um INSERT por verificacao de equipamento).
"""
import os
import sqlite3
import threading
from datetime import datetime, timedelta
from typing import Optional

DB_PATH = os.environ.get(
    "PINGADOR_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "pingador.db"),
)

# Por quantos dias manter as amostras de ping. Amostras mais antigas sao
# removidas periodicamente para o arquivo nao crescer sem limite.
RETENTION_DAYS = int(os.environ.get("PINGADOR_DB_RETENTION_DAYS", "30"))

# Eventos (quedas / recuperacoes / cadastros / remocoes) sao poucos e mais
# valiosos que as amostras de ping, entao ficam guardados por mais tempo.
EVENTS_RETENTION_DAYS = int(os.environ.get("PINGADOR_EVENTS_RETENTION_DAYS", "180"))

# A cada N escritas, dispara uma limpeza das amostras vencidas.
_PRUNE_EVERY = 500

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None
_writes_since_prune = 0


class EquipmentIPConflict(Exception):
    """IP ja cadastrado na tabela equipment."""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db() -> None:
    """Cria o schema (idempotente) e abre a conexao compartilhada."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = _connect()
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ping_samples (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                equipment_id     INTEGER NOT NULL,
                ip               TEXT,
                name             TEXT,
                ts               TEXT NOT NULL,
                success          INTEGER NOT NULL,
                response_time_ms REAL
            );

            CREATE INDEX IF NOT EXISTS idx_ping_samples_eq_ts
                ON ping_samples (equipment_id, ts);

            CREATE TABLE IF NOT EXISTS equipment_state (
                equipment_id          INTEGER PRIMARY KEY,
                name                  TEXT,
                ip                    TEXT,
                last_checked_at       TEXT,
                last_success_at       TEXT,
                last_failure_at       TEXT,
                last_response_time_ms REAL,
                updated_at            TEXT
            );

            CREATE TABLE IF NOT EXISTS events (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                equipment_id     INTEGER,
                equipment_name   TEXT,
                ip               TEXT,
                category         TEXT,
                kind             TEXT NOT NULL,   -- down | up | created | removed
                previous_status  TEXT,
                current_status   TEXT,
                response_time_ms REAL,
                duration_seconds REAL,            -- para 'up': quanto durou a queda
                ts               TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_ts       ON events (ts);
            CREATE INDEX IF NOT EXISTS idx_events_kind_ts  ON events (kind, ts);
            CREATE INDEX IF NOT EXISTS idx_events_eq       ON events (equipment_id);

            -- Topologia de rede: posicao dos nos e conexoes cadastradas pelo
            -- usuario. Chaveado por IP porque o id do equipamento e em memoria
            -- e pode ser reatribuido no restart / sincronizacao da planilha.
            CREATE TABLE IF NOT EXISTS device_layout (
                ip         TEXT PRIMARY KEY,
                pos_x      REAL,
                pos_y      REAL,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS topology_connections (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                source_ip  TEXT NOT NULL,
                target_ip  TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_topo_conn_src ON topology_connections (source_ip);
            CREATE INDEX IF NOT EXISTS idx_topo_conn_tgt ON topology_connections (target_ip);

            -- Cadastro dos equipamentos monitorados. Antes vivia so em RAM
            -- (storage.py) e era reconstruido da planilha a cada restart;
            -- agora e a fonte duravel. O `store` em memoria e apenas um
            -- working-set carregado desta tabela no boot.
            CREATE TABLE IF NOT EXISTS equipment (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                ip                TEXT NOT NULL UNIQUE,
                name              TEXT NOT NULL,
                description       TEXT DEFAULT '',
                frequency         INTEGER NOT NULL DEFAULT 15,
                category          TEXT DEFAULT 'Manual',
                source            TEXT NOT NULL DEFAULT 'manual',  -- origem: 'manual' | 'excel' (informativo)
                monitoring_active INTEGER NOT NULL DEFAULT 1,
                created_at        TEXT,
                updated_at        TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_equipment_source ON equipment (source);
            """
        )
        _conn.commit()


def _require_conn() -> sqlite3.Connection:
    if _conn is None:
        init_db()
    assert _conn is not None
    return _conn


# --------------------------- escrita ---------------------------

def record_ping(
    equipment_id: int,
    ip: Optional[str],
    name: Optional[str],
    success: bool,
    response_time_ms: Optional[float],
    ts: Optional[datetime] = None,
) -> None:
    """
    Registra uma amostra de verificacao e atualiza o snapshot do
    equipamento (ultima verificacao / ultimo sucesso / ultima falha).

    Nunca deve derrubar o monitoramento: chamadores devem envolver em
    try/except, mas aqui tambem engolimos erros de I/O por seguranca.
    """
    global _writes_since_prune
    now = ts or datetime.now()
    now_iso = now.isoformat()
    conn = _require_conn()

    with _lock:
        try:
            conn.execute(
                "INSERT INTO ping_samples "
                "(equipment_id, ip, name, ts, success, response_time_ms) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (equipment_id, ip, name, now_iso, 1 if success else 0, response_time_ms),
            )
            conn.execute(
                """
                INSERT INTO equipment_state (
                    equipment_id, name, ip, last_checked_at,
                    last_success_at, last_failure_at,
                    last_response_time_ms, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(equipment_id) DO UPDATE SET
                    name                  = excluded.name,
                    ip                    = excluded.ip,
                    last_checked_at       = excluded.last_checked_at,
                    last_success_at       = COALESCE(excluded.last_success_at, equipment_state.last_success_at),
                    last_failure_at       = COALESCE(excluded.last_failure_at, equipment_state.last_failure_at),
                    last_response_time_ms = excluded.last_response_time_ms,
                    updated_at            = excluded.updated_at
                """,
                (
                    equipment_id,
                    name,
                    ip,
                    now_iso,
                    now_iso if success else None,
                    None if success else now_iso,
                    response_time_ms if success else None,
                    now_iso,
                ),
            )
            conn.commit()
            _writes_since_prune += 1
            if _writes_since_prune >= _PRUNE_EVERY:
                _writes_since_prune = 0
                _prune_locked()
        except sqlite3.Error:
            # não propaga: perder uma amostra é preferível a interromper o monitor
            try:
                conn.rollback()
            except sqlite3.Error:
                pass


def _prune_locked() -> None:
    if RETENTION_DAYS > 0:
        cutoff = (datetime.now() - timedelta(days=RETENTION_DAYS)).isoformat()
        _conn.execute("DELETE FROM ping_samples WHERE ts < ?", (cutoff,))
    if EVENTS_RETENTION_DAYS > 0:
        ev_cutoff = (datetime.now() - timedelta(days=EVENTS_RETENTION_DAYS)).isoformat()
        _conn.execute("DELETE FROM events WHERE ts < ?", (ev_cutoff,))
    _conn.commit()


def forget_equipment(equipment_id: int) -> None:
    """
    Remove amostras de ping e o snapshot de um equipamento excluido.

    Os eventos (queda/recuperacao/cadastro/remocao) sao mantidos de
    proposito: a linha do tempo continua mostrando o historico daquele
    equipamento mesmo depois de ele sair do monitoramento.
    """
    conn = _require_conn()
    with _lock:
        try:
            conn.execute("DELETE FROM ping_samples WHERE equipment_id = ?", (equipment_id,))
            conn.execute("DELETE FROM equipment_state WHERE equipment_id = ?", (equipment_id,))
            conn.commit()
        except sqlite3.Error:
            pass


# --------------------------- cadastro de equipamentos ---------------------------

# colunas que update_equipment aceita alterar
_EQUIPMENT_UPDATABLE = (
    "name", "description", "frequency", "category", "source", "monitoring_active",
)


def list_equipment() -> list[dict]:
    """Todas as linhas de `equipment` (ordem de id). Hidrata o store no boot."""
    conn = _require_conn()
    with _lock:
        rows = conn.execute("SELECT * FROM equipment ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def get_equipment_by_ip(ip: str) -> Optional[dict]:
    conn = _require_conn()
    with _lock:
        row = conn.execute("SELECT * FROM equipment WHERE ip = ?", (ip,)).fetchone()
    return dict(row) if row else None


def insert_equipment(
    *,
    ip: str,
    name: str,
    description: str,
    frequency: int,
    category: str = "Manual",
    source: str = "manual",
    monitoring_active: bool = True,
    equipment_id: Optional[int] = None,
) -> int:
    """
    Insere um equipamento e devolve o id (o passado em `equipment_id`, quando
    houver - usado pelo import para adotar o id historico -, senao o
    AUTOINCREMENT).

    Escrita CRITICA: IP duplicado vira EquipmentIPConflict; qualquer outro
    erro de sqlite e propagado (uma persistencia que falha nao pode parecer
    ter dado certo).
    """
    now_iso = datetime.now().isoformat()
    conn = _require_conn()
    with _lock:
        try:
            if equipment_id is not None:
                cur = conn.execute(
                    "INSERT INTO equipment (id, ip, name, description, frequency, "
                    "category, source, monitoring_active, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        equipment_id, ip, name, description or "", int(frequency),
                        category or "Manual", source or "manual",
                        1 if monitoring_active else 0, now_iso, now_iso,
                    ),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO equipment (ip, name, description, frequency, "
                    "category, source, monitoring_active, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        ip, name, description or "", int(frequency),
                        category or "Manual", source or "manual",
                        1 if monitoring_active else 0, now_iso, now_iso,
                    ),
                )
            conn.commit()
            return int(equipment_id if equipment_id is not None else cur.lastrowid)
        except sqlite3.IntegrityError:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            raise EquipmentIPConflict(ip)
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            raise


def update_equipment(equipment_id: int, **fields) -> None:
    """
    UPDATE parcial de `equipment` (whitelist em _EQUIPMENT_UPDATABLE); sempre
    seta updated_at. Best-effort: erros de I/O sao engolidos, exceto conflito
    de IP unico (EquipmentIPConflict), util para a tela de edicao.
    """
    cols = [c for c in fields if c in _EQUIPMENT_UPDATABLE]
    has_ip = "ip" in fields  # ip tem constraint UNIQUE, tratado a parte
    if not cols and not has_ip:
        return

    sets = []
    params: list = []
    if has_ip:
        sets.append("ip = ?")
        params.append(fields["ip"])
    for c in cols:
        val = fields[c]
        if c == "monitoring_active":
            val = 1 if val else 0
        elif c == "frequency":
            val = int(val)
        sets.append(f"{c} = ?")
        params.append(val)
    sets.append("updated_at = ?")
    params.append(datetime.now().isoformat())
    params.append(equipment_id)

    conn = _require_conn()
    with _lock:
        try:
            conn.execute(
                f"UPDATE equipment SET {', '.join(sets)} WHERE id = ?", params
            )
            conn.commit()
        except sqlite3.IntegrityError:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            raise EquipmentIPConflict(fields.get("ip"))
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass


def delete_equipment_row(equipment_id: int) -> None:
    """DELETE FROM equipment WHERE id = ?. Best-effort."""
    conn = _require_conn()
    with _lock:
        try:
            conn.execute("DELETE FROM equipment WHERE id = ?", (equipment_id,))
            conn.commit()
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass


def rekey_device_layout(old_ip: str, new_ip: str) -> None:
    """
    Move a posicao salva do no na topologia quando o IP de um equipamento
    muda na edicao. Best-effort; se new_ip ja tiver posicao, mantem a dela.
    """
    if not old_ip or not new_ip or old_ip == new_ip:
        return
    conn = _require_conn()
    with _lock:
        try:
            exists = conn.execute(
                "SELECT 1 FROM device_layout WHERE ip = ? LIMIT 1", (new_ip,)
            ).fetchone()
            if exists:
                conn.execute("DELETE FROM device_layout WHERE ip = ?", (old_ip,))
            else:
                conn.execute(
                    "UPDATE device_layout SET ip = ? WHERE ip = ?", (new_ip, old_ip)
                )
            conn.commit()
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass


def down_counts_by_ip() -> dict:
    """{ip: nº de eventos 'down'} - para semear down_count no boot."""
    conn = _require_conn()
    with _lock:
        rows = conn.execute(
            "SELECT ip, COUNT(*) AS c FROM events WHERE kind = 'down' "
            "AND ip IS NOT NULL GROUP BY ip"
        ).fetchall()
    return {r["ip"]: r["c"] for r in rows}


# --------------------------- eventos / linha do tempo ---------------------------

_VALID_EVENT_KINDS = ("down", "up", "created", "removed")


def record_event(
    equipment_id: Optional[int],
    equipment_name: Optional[str],
    ip: Optional[str],
    kind: str,
    *,
    category: Optional[str] = None,
    previous_status: Optional[str] = None,
    current_status: Optional[str] = None,
    response_time_ms: Optional[float] = None,
    duration_seconds: Optional[float] = None,
    ts: Optional[datetime] = None,
    dedupe_created_by_ip: bool = False,
) -> None:
    """
    Registra um evento na linha do tempo. `kind`: down | up | created | removed.

    Se `dedupe_created_by_ip` e True (usado na carga em massa vinda da
    planilha), nao registra um 'created' se ja houver um para o mesmo IP,
    evitando encher a linha do tempo a cada reinicializacao.
    """
    if kind not in _VALID_EVENT_KINDS:
        return
    now_iso = (ts or datetime.now()).isoformat()
    conn = _require_conn()
    with _lock:
        try:
            if dedupe_created_by_ip and kind == "created":
                seen = conn.execute(
                    "SELECT 1 FROM events WHERE ip = ? AND kind = 'created' LIMIT 1",
                    (ip,),
                ).fetchone()
                if seen:
                    return
            conn.execute(
                "INSERT INTO events ("
                "  equipment_id, equipment_name, ip, category, kind, "
                "  previous_status, current_status, response_time_ms, "
                "  duration_seconds, ts"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    equipment_id, equipment_name, ip, category, kind,
                    previous_status, current_status, response_time_ms,
                    duration_seconds, now_iso,
                ),
            )
            conn.commit()
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass


def query_events(
    *,
    since: Optional[str] = None,
    until: Optional[str] = None,
    kinds: Optional[list[str]] = None,
    equipment_id: Optional[int] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 3000,
    order: str = "asc",
) -> list[dict]:
    conn = _require_conn()
    clauses: list[str] = []
    params: list = []

    if since:
        clauses.append("ts >= ?")
        params.append(since)
    if until:
        clauses.append("ts <= ?")
        params.append(until)
    if kinds:
        kinds = [k for k in kinds if k in _VALID_EVENT_KINDS]
        if kinds:
            clauses.append(f"kind IN ({','.join('?' * len(kinds))})")
            params.extend(kinds)
    if equipment_id is not None:
        clauses.append("equipment_id = ?")
        params.append(equipment_id)
    if category:
        clauses.append("category = ?")
        params.append(category)
    if search:
        clauses.append("(equipment_name LIKE ? OR ip LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like])

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    direction = "DESC" if str(order).lower() == "desc" else "ASC"
    limit = max(1, min(int(limit), 20000))

    with _lock:
        rows = conn.execute(
            f"SELECT * FROM events{where} ORDER BY ts {direction}, id {direction} LIMIT ?",
            params + [limit],
        ).fetchall()
    return [dict(r) for r in rows]


def events_bounds() -> dict:
    """Extremos e contagens da linha do tempo, para calibrar o zoom inicial."""
    conn = _require_conn()
    with _lock:
        row = conn.execute(
            "SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS total FROM events"
        ).fetchone()
        by_kind = conn.execute(
            "SELECT kind, COUNT(*) AS c FROM events GROUP BY kind"
        ).fetchall()
    return {
        "first_ts": row["first_ts"],
        "last_ts": row["last_ts"],
        "total": row["total"] or 0,
        "by_kind": {r["kind"]: r["c"] for r in by_kind},
    }


# --------------------------- leitura ---------------------------

def _window_start_iso(window: str) -> Optional[str]:
    """Converte '1h','24h','7d','30d','all' no inicio da janela (ISO) ou None."""
    window = (window or "24h").strip().lower()
    if window in ("all", "todos", ""):
        return None
    mapping = {
        "1h": timedelta(hours=1),
        "6h": timedelta(hours=6),
        "12h": timedelta(hours=12),
        "24h": timedelta(hours=24),
        "48h": timedelta(hours=48),
        "7d": timedelta(days=7),
        "14d": timedelta(days=14),
        "30d": timedelta(days=30),
    }
    delta = mapping.get(window, timedelta(hours=24))
    return (datetime.now() - delta).isoformat()


def get_state(equipment_id: int) -> Optional[dict]:
    conn = _require_conn()
    with _lock:
        row = conn.execute(
            "SELECT * FROM equipment_state WHERE equipment_id = ?", (equipment_id,)
        ).fetchone()
    return dict(row) if row else None


def list_states() -> list[dict]:
    conn = _require_conn()
    with _lock:
        rows = conn.execute("SELECT * FROM equipment_state").fetchall()
    return [dict(r) for r in rows]


def get_availability(equipment_id: int, window: str = "24h") -> dict:
    """
    Resumo de disponibilidade de um equipamento na janela informada.

    uptime_percent = amostras com sucesso / total de amostras * 100.
    """
    conn = _require_conn()
    start = _window_start_iso(window)
    params: list = [equipment_id]
    where = "equipment_id = ?"
    if start:
        where += " AND ts >= ?"
        params.append(start)

    with _lock:
        row = conn.execute(
            f"""
            SELECT
                COUNT(*)                                        AS total,
                COALESCE(SUM(success), 0)                       AS ok,
                AVG(CASE WHEN success = 1 THEN response_time_ms END) AS avg_ms,
                MIN(CASE WHEN success = 1 THEN response_time_ms END) AS min_ms,
                MAX(CASE WHEN success = 1 THEN response_time_ms END) AS max_ms,
                MIN(ts)                                         AS first_ts,
                MAX(ts)                                         AS last_ts
            FROM ping_samples
            WHERE {where}
            """,
            params,
        ).fetchone()

    state = get_state(equipment_id) or {}
    total = row["total"] or 0
    ok = row["ok"] or 0
    fail = total - ok
    uptime = round((ok / total) * 100, 2) if total else None

    return {
        "window": (window or "24h"),
        "total_checks": total,
        "successful_checks": ok,
        "failed_checks": fail,
        "uptime_percent": uptime,
        "downtime_percent": round(100 - uptime, 2) if uptime is not None else None,
        "avg_response_time_ms": round(row["avg_ms"], 1) if row["avg_ms"] is not None else None,
        "min_response_time_ms": round(row["min_ms"], 1) if row["min_ms"] is not None else None,
        "max_response_time_ms": round(row["max_ms"], 1) if row["max_ms"] is not None else None,
        "first_sample_at": row["first_ts"],
        "last_sample_at": row["last_ts"],
        "last_checked_at": state.get("last_checked_at"),
        "last_success_at": state.get("last_success_at"),
        "last_failure_at": state.get("last_failure_at"),
    }


def get_availability_series(
    equipment_id: int, window: str = "24h", bucket: Optional[str] = None
) -> list[dict]:
    """
    Serie temporal de disponibilidade para grafico de barras: cada ponto
    e um intervalo (hora ou dia) com o percentual de amostras bem-sucedidas.
    """
    conn = _require_conn()
    start = _window_start_iso(window)

    if bucket not in ("hour", "day"):
        bucket = "day" if (window or "").lower() in ("7d", "14d", "30d") else "hour"
    fmt = "%Y-%m-%dT%H:00:00" if bucket == "hour" else "%Y-%m-%d"

    params: list = [equipment_id]
    where = "equipment_id = ?"
    if start:
        where += " AND ts >= ?"
        params.append(start)

    with _lock:
        rows = conn.execute(
            f"""
            SELECT
                strftime('{fmt}', ts)      AS bucket_start,
                COUNT(*)                   AS total,
                COALESCE(SUM(success), 0)  AS ok,
                AVG(CASE WHEN success = 1 THEN response_time_ms END) AS avg_ms
            FROM ping_samples
            WHERE {where}
            GROUP BY bucket_start
            ORDER BY bucket_start
            """,
            params,
        ).fetchall()

    series = []
    for r in rows:
        total = r["total"] or 0
        ok = r["ok"] or 0
        series.append(
            {
                "bucket_start": r["bucket_start"],
                "bucket": bucket,
                "total_checks": total,
                "successful_checks": ok,
                "uptime_percent": round((ok / total) * 100, 2) if total else None,
                "avg_response_time_ms": round(r["avg_ms"], 1) if r["avg_ms"] is not None else None,
            }
        )
    return series


# --------------------------- topologia de rede ---------------------------

def get_device_layout() -> dict:
    """Posicoes salvas dos nos: { ip: {"x": float, "y": float} }."""
    conn = _require_conn()
    with _lock:
        rows = conn.execute("SELECT ip, pos_x, pos_y FROM device_layout").fetchall()
    return {
        r["ip"]: {"x": r["pos_x"], "y": r["pos_y"]}
        for r in rows
        if r["pos_x"] is not None and r["pos_y"] is not None
    }


def save_device_layout(positions: dict) -> int:
    """Upsert das posicoes. `positions`: { ip: {"x": .., "y": ..} }."""
    if not positions:
        return 0
    now = datetime.now().isoformat()
    conn = _require_conn()
    n = 0
    with _lock:
        try:
            for ip, p in positions.items():
                if not ip or not isinstance(p, dict):
                    continue
                x, y = p.get("x"), p.get("y")
                if x is None or y is None:
                    continue
                conn.execute(
                    "INSERT INTO device_layout (ip, pos_x, pos_y, updated_at) "
                    "VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(ip) DO UPDATE SET "
                    "  pos_x = excluded.pos_x, pos_y = excluded.pos_y, "
                    "  updated_at = excluded.updated_at",
                    (str(ip), float(x), float(y), now),
                )
                n += 1
            conn.commit()
        except (sqlite3.Error, TypeError, ValueError):
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
    return n


def list_connections() -> list[dict]:
    conn = _require_conn()
    with _lock:
        rows = conn.execute(
            "SELECT id, source_ip, target_ip FROM topology_connections ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def add_connection(source_ip: str, target_ip: str) -> Optional[dict]:
    """Cria uma conexao (nao-direcionada); se o par ja existir, devolve o existente."""
    if not source_ip or not target_ip or source_ip == target_ip:
        return None
    conn = _require_conn()
    now = datetime.now().isoformat()
    with _lock:
        try:
            existing = conn.execute(
                "SELECT id, source_ip, target_ip FROM topology_connections "
                "WHERE (source_ip = ? AND target_ip = ?) "
                "   OR (source_ip = ? AND target_ip = ?) LIMIT 1",
                (source_ip, target_ip, target_ip, source_ip),
            ).fetchone()
            if existing:
                return dict(existing)
            cur = conn.execute(
                "INSERT INTO topology_connections "
                "(source_ip, target_ip, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (source_ip, target_ip, now, now),
            )
            conn.commit()
            return {"id": cur.lastrowid, "source_ip": source_ip, "target_ip": target_ip}
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            return None


def delete_connection(conn_id: int) -> bool:
    conn = _require_conn()
    with _lock:
        try:
            cur = conn.execute(
                "DELETE FROM topology_connections WHERE id = ?", (conn_id,)
            )
            conn.commit()
            return cur.rowcount > 0
        except sqlite3.Error:
            return False


# inicializa o schema assim que o modulo e importado
init_db()
