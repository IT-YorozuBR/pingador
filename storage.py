"""
Camada de armazenamento em memoria.

Toda a aplicacao acessa os dados atraves da instancia `store` deste modulo.
Isso isola o "banco de dados" (hoje dicts/listas em RAM) do resto do
codigo, para que no futuro seja possivel trocar por SQLite/PostgreSQL
apenas reescrevendo esta classe, sem mexer nas rotas Flask.
"""
import ipaddress
import threading
from collections import deque
from datetime import datetime
from typing import Optional

import db
from models import Equipment, Event, next_id, STATUS_WAITING, STATUS_ONLINE, STATUS_OFFLINE

# quantidade de amostras de ping mantidas por equipamento (para o grafico
# estilo "monitor cardiaco")
PING_HISTORY_MAXLEN = 40

# quantidade de falhas de ping consecutivas exigidas antes de declarar
# o equipamento como offline (evita falso-positivo por perda isolada de
# pacote ICMP)
FAILURE_THRESHOLD = 3

_event_id_counter_lock = threading.Lock()
_event_id = 0


def _next_event_id() -> int:
    global _event_id
    with _event_id_counter_lock:
        _event_id += 1
        return _event_id


class ValidationError(Exception):
    pass


class InMemoryStore:
    def __init__(self):
        self._lock = threading.RLock()
        self.equipments: dict[int, Equipment] = {}
        self.events: list[Event] = []
        # historico curto de amostras de ping por equipamento, usado no
        # grafico "monitor de pulso" (nao confundir com self.events, que
        # guarda apenas as transicoes de queda/recuperacao)
        self.ping_history: dict[int, deque] = {}

    # ---------- Equipamentos ----------

    def validate_equipment_input(self, ip: str, name: str, description: str, frequency):
        if not name or not name.strip():
            raise ValidationError("O nome do equipamento e obrigatorio.")

        if not ip or not ip.strip():
            raise ValidationError("O IP e obrigatorio.")
        try:
            ipaddress.ip_address(ip.strip())
        except ValueError:
            raise ValidationError(f"IP invalido: {ip}")

        try:
            frequency = int(frequency)
        except (TypeError, ValueError):
            raise ValidationError("A frequencia deve ser um numero inteiro de segundos.")
        if frequency < 1:
            raise ValidationError("A frequencia deve ser maior ou igual a 1 segundo.")

        return ip.strip(), name.strip(), (description or "").strip(), frequency

    def add_equipment(
        self, ip: str, name: str, description: str, frequency,
        category: str = "Manual", source: str = "manual",
    ) -> Equipment:
        ip, name, description, frequency = self.validate_equipment_input(
            ip, name, description, frequency
        )
        with self._lock:
            eq = Equipment(
                id=next_id(),
                ip=ip,
                name=name,
                description=description,
                frequency=frequency,
                category=category,
                source=source,
                status=STATUS_WAITING,
                next_check_at=datetime.now(),  # verifica assim que possivel
            )
            self.equipments[eq.id] = eq
            self.ping_history[eq.id] = deque(maxlen=PING_HISTORY_MAXLEN)
            return eq

    def sync_from_excel(self, entries: list[dict]) -> dict:
        """
        Sincroniza os equipamentos com a lista de entradas lidas da planilha
        de inventario (uma entrada por IP, ver excel_sync.py).

        Equipamentos com source="excel" sao criados/atualizados/removidos
        para espelhar o conteudo atual da planilha. Equipamentos cadastrados
        manualmente pela tela (source="manual") nunca sao alterados aqui,
        mesmo que o IP tambem apareca na planilha.
        """
        with self._lock:
            existing_by_ip = {eq.ip: eq for eq in self.equipments.values()}
            seen_ips = set()
            added = updated = removed = 0

            for entry in entries:
                ip = entry["ip"]
                seen_ips.add(ip)
                eq = existing_by_ip.get(ip)

                if eq is None:
                    eq = Equipment(
                        id=next_id(),
                        ip=ip,
                        name=entry["name"],
                        description=entry["description"],
                        frequency=entry["frequency"],
                        category=entry["category"],
                        source="excel",
                        status=STATUS_WAITING,
                        next_check_at=datetime.now(),
                    )
                    self.equipments[eq.id] = eq
                    self.ping_history[eq.id] = deque(maxlen=PING_HISTORY_MAXLEN)
                    added += 1
                elif eq.source == "excel":
                    changed = False
                    if eq.name != entry["name"]:
                        eq.name = entry["name"]
                        changed = True
                    if eq.description != entry["description"]:
                        eq.description = entry["description"]
                        changed = True
                    if eq.category != entry["category"]:
                        eq.category = entry["category"]
                        changed = True
                    if eq.frequency != entry["frequency"]:
                        eq.frequency = entry["frequency"]
                        changed = True
                    if changed:
                        updated += 1
                # equipamento manual com mesmo IP: mantido como esta, sem
                # alteracoes (mas o IP nao sera removido abaixo por nao ter
                # source == "excel")

            to_remove = [
                eq.id for eq in self.equipments.values()
                if eq.source == "excel" and eq.ip not in seen_ips
            ]
            for eid in to_remove:
                del self.equipments[eid]
                self.ping_history.pop(eid, None)
                self.events = [e for e in self.events if e.equipment_id != eid]
                try:
                    db.forget_equipment(eid)
                except Exception:
                    pass
                removed += 1

            return {
                "added": added,
                "updated": updated,
                "removed": removed,
                "total_in_excel": len(entries),
            }

    def list_categories(self) -> list[str]:
        with self._lock:
            return sorted({eq.category for eq in self.equipments.values()})

    def remove_equipment(self, equipment_id: int) -> bool:
        with self._lock:
            if equipment_id in self.equipments:
                del self.equipments[equipment_id]
                self.ping_history.pop(equipment_id, None)
                self.events = [e for e in self.events if e.equipment_id != equipment_id]
                try:
                    db.forget_equipment(equipment_id)
                except Exception:
                    pass
                return True
            return False

    def toggle_monitoring(self, equipment_id: int) -> Optional[Equipment]:
        with self._lock:
            eq = self.equipments.get(equipment_id)
            if not eq:
                return None
            eq.monitoring_active = not eq.monitoring_active
            if eq.monitoring_active:
                # ao reativar, verifica assim que possivel
                eq.next_check_at = datetime.now()
                eq.status = STATUS_WAITING
            return eq

    def list_equipments(self) -> list[Equipment]:
        with self._lock:
            return list(self.equipments.values())

    def get_equipment(self, equipment_id: int) -> Optional[Equipment]:
        with self._lock:
            return self.equipments.get(equipment_id)

    # ---------- Eventos / historico ----------

    def register_ping_result(self, equipment_id: int, success: bool, response_time_ms):
        """
        Atualiza o status do equipamento a partir do resultado do ping e
        registra evento de queda/recuperacao quando houver transicao.
        """
        with self._lock:
            eq = self.equipments.get(equipment_id)
            if not eq:
                return

            previous_status = eq.status
            now = datetime.now()

            if success:
                eq.consecutive_failures = 0
                new_status = STATUS_ONLINE
            else:
                eq.consecutive_failures += 1
                # so confirma a queda apos N falhas seguidas; ate la,
                # mantem o ultimo status conhecido (evita flapping por
                # perda isolada de pacote ICMP)
                if previous_status == STATUS_OFFLINE or eq.consecutive_failures >= FAILURE_THRESHOLD:
                    new_status = STATUS_OFFLINE
                else:
                    new_status = previous_status

            eq.last_checked = now
            eq.last_response_time_ms = response_time_ms if success else None

            # Queda: estava online (ou aguardando) e virou offline
            if new_status == STATUS_OFFLINE and previous_status != STATUS_OFFLINE:
                eq.down_count += 1
                eq.last_down_at = now
                self.events.append(
                    Event(
                        id=_next_event_id(),
                        equipment_id=equipment_id,
                        previous_status=previous_status,
                        current_status=new_status,
                        response_time_ms=response_time_ms,
                        down_at=now,
                        timestamp=now,
                    )
                )

            # Recuperacao: estava offline e virou online
            elif new_status == STATUS_ONLINE and previous_status == STATUS_OFFLINE:
                eq.last_up_at = now
                # encontra o ultimo evento de queda ainda aberto (sem up_at)
                for event in reversed(self.events):
                    if event.equipment_id == equipment_id and event.up_at is None:
                        event.up_at = now
                        event.duration_seconds = (now - event.down_at).total_seconds()
                        break
                self.events.append(
                    Event(
                        id=_next_event_id(),
                        equipment_id=equipment_id,
                        previous_status=previous_status,
                        current_status=new_status,
                        response_time_ms=response_time_ms,
                        up_at=now,
                        timestamp=now,
                    )
                )

            eq.status = new_status

            # registra a amostra no historico de pulso (toda verificacao,
            # com sucesso ou falha)
            history = self.ping_history.setdefault(
                equipment_id, deque(maxlen=PING_HISTORY_MAXLEN)
            )
            history.append(
                {
                    "timestamp": now.isoformat(),
                    "response_time_ms": response_time_ms if success else None,
                    "success": success,
                }
            )

            # persiste a amostra no SQLite (historico de disponibilidade e
            # "ultima vez bem sucedida"). Falha de I/O aqui nao pode
            # interromper o monitoramento.
            try:
                db.record_ping(
                    equipment_id=equipment_id,
                    ip=eq.ip,
                    name=eq.name,
                    success=success,
                    response_time_ms=response_time_ms if success else None,
                    ts=now,
                )
            except Exception:
                pass

    def list_events(self, equipment_id: Optional[int] = None, limit: int = 200) -> list[Event]:
        with self._lock:
            events = self.events
            if equipment_id is not None:
                events = [e for e in events if e.equipment_id == equipment_id]
            return list(reversed(events))[:limit]

    def get_ping_history(self, equipment_id: Optional[int] = None):
        """
        Retorna o historico curto de amostras de ping (ordem cronologica).
        Sem equipment_id, retorna um dict {equipment_id: [amostras]} com
        o historico de todos os equipamentos, usado no monitor de pulso.
        """
        with self._lock:
            if equipment_id is not None:
                return list(self.ping_history.get(equipment_id, []))
            return {eid: list(hist) for eid, hist in self.ping_history.items()}


# Instancia global unica usada por toda a aplicacao
store = InMemoryStore()
