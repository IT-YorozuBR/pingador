"""
Motor de monitoramento em background.

Um unico thread "scheduler" verifica, a cada segundo, quais equipamentos
estao com o prazo de verificacao vencido (respeitando a frequencia
individual de cada um) e dispara o ping em uma thread do pool, para nao
bloquear equipamentos com frequencias diferentes entre si.
"""
import platform
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from storage import store

IS_WINDOWS = platform.system().lower() == "windows"

_executor = ThreadPoolExecutor(max_workers=20)
_stop_event = threading.Event()


def ping_host(ip: str, timeout_ms: int = 1500):
    """
    Executa um ping ICMP compativel com Windows e Linux.
    Retorna (sucesso: bool, tempo_resposta_ms: float|None).
    """
    if IS_WINDOWS:
        cmd = ["ping", "-n", "1", "-w", str(timeout_ms), ip]
    else:
        cmd = ["ping", "-c", "1", "-W", str(max(1, timeout_ms // 1000)), ip]

    start = time.perf_counter()
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=(timeout_ms / 1000) + 1,
        )
        elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
        success = result.returncode == 0
        return success, (elapsed_ms if success else None)
    except (subprocess.TimeoutExpired, OSError):
        return False, None


def _check_equipment(equipment_id: int):
    eq = store.get_equipment(equipment_id)
    if not eq:
        return
    success, response_time_ms = ping_host(eq.ip)
    store.register_ping_result(equipment_id, success, response_time_ms)

    # agenda a proxima verificacao respeitando a frequencia individual
    eq = store.get_equipment(equipment_id)
    if eq:
        eq.next_check_at = datetime.now() + timedelta(seconds=eq.frequency)


def _scheduler_loop():
    while not _stop_event.is_set():
        now = datetime.now()
        for eq in store.list_equipments():
            if not eq.monitoring_active:
                continue
            if eq.next_check_at is None or now >= eq.next_check_at:
                # evita reenvio duplicado enquanto o ping esta em voo
                eq.next_check_at = now + timedelta(seconds=eq.frequency)
                _executor.submit(_check_equipment, eq.id)
        _stop_event.wait(1)  # verifica a fila a cada 1 segundo


_scheduler_thread = None


def start_scheduler():
    global _scheduler_thread
    if _scheduler_thread is None or not _scheduler_thread.is_alive():
        _stop_event.clear()
        _scheduler_thread = threading.Thread(target=_scheduler_loop, daemon=True)
        _scheduler_thread.start()


def stop_scheduler():
    _stop_event.set()
