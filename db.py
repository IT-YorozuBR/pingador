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


# inicializa o schema assim que o modulo e importado
init_db()
