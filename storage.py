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
from models import Equipment, Event, STATUS_WAITING, STATUS_ONLINE, STATUS_OFFLINE

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
        self._loaded = False
        self.equipments: dict[int, Equipment] = {}
        self.events: list[Event] = []
        # historico curto de amostras de ping por equipamento, usado no
        # grafico "monitor de pulso" (nao confundir com self.events, que
        # guarda apenas as transicoes de queda/recuperacao)
        self.ping_history: dict[int, deque] = {}

    # ---------- Equipamentos ----------

    def load(self) -> None:
        """
        Hidrata self.equipments a partir da tabela `equipment` (db.py).
        Chamado uma vez no boot, antes do scheduler. Idempotente.

        Os campos "ao vivo" (status real, last_checked, tempo de resposta)
        nao sao restaurados de proposito: o proximo ciclo de verificacao
        (dentro de 1x `frequency`) os recompoe. `down_count` e semeado do
        historico de eventos por IP.
        """
        with self._lock:
            if self._loaded:
                return
            downs = db.down_counts_by_ip()
            now = datetime.now()
            for r in db.list_equipment():
                eq = Equipment(
                    id=r["id"],
                    ip=r["ip"],
                    name=r["name"],
                    description=r["description"] or "",
                    frequency=r["frequency"],
                    category=r["category"] or "Manual",
                    source=r["source"] or "manual",
                    monitoring_active=bool(r["monitoring_active"]),
                    status=STATUS_WAITING,
                    next_check_at=now,
                )
                eq.down_count = downs.get(eq.ip, 0)
                self.equipments[eq.id] = eq
                self.ping_history[eq.id] = deque(maxlen=PING_HISTORY_MAXLEN)
            self._loaded = True

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
            if any(e.ip == ip for e in self.equipments.values()):
                raise ValidationError(f"Ja existe um equipamento com o IP {ip}.")
            try:
                new_id = db.insert_equipment(
                    ip=ip, name=name, description=description, frequency=frequency,
                    category=category, source=source, monitoring_active=True,
                )
            except db.EquipmentIPConflict:
                raise ValidationError(f"Ja existe um equipamento com o IP {ip}.")

            eq = Equipment(
                id=new_id,
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
            try:
                db.record_event(
                    eq.id, eq.name, eq.ip, "created", category=eq.category,
                    current_status=eq.status,
                )
            except Exception:
                pass
            return eq

    def update_equipment(
        self, equipment_id: int,
        *, ip=None, name=None, description=None, frequency=None, category=None,
    ) -> Optional[Equipment]:
        """
        Edita um equipamento ja cadastrado (tela de edicao). Valida os
        campos, atualiza o objeto em RAM e persiste na tabela `equipment`.
        Se a frequencia mudar, re-agenda a proxima verificacao.
        """
        with self._lock:
            eq = self.equipments.get(equipment_id)
            if not eq:
                return None

            ip, name, description, frequency = self.validate_equipment_input(
                ip, name, description, frequency
            )
            category = (category or eq.category or "Manual").strip() or "Manual"

            if ip != eq.ip and any(
                e.ip == ip and e.id != equipment_id for e in self.equipments.values()
            ):
                raise ValidationError(f"Ja existe um equipamento com o IP {ip}.")

            old_ip = eq.ip
            freq_changed = frequency != eq.frequency

            eq.ip = ip
            eq.name = name
            eq.description = description
            eq.frequency = frequency
            eq.category = category
            if freq_changed:
                eq.next_check_at = datetime.now()

            try:
                db.update_equipment(
                    equipment_id, ip=ip, name=name, description=description,
                    frequency=frequency, category=category,
                )
            except db.EquipmentIPConflict:
                raise ValidationError(f"Ja existe um equipamento com o IP {ip}.")
            except Exception:
                pass

            if ip != old_ip:
                try:
                    db.rekey_device_layout(old_ip, ip)
                except Exception:
                    pass

            return eq

    def list_categories(self) -> list[str]:
        with self._lock:
            return sorted({eq.category for eq in self.equipments.values()})

    def remove_equipment(self, equipment_id: int) -> bool:
        with self._lock:
            if equipment_id in self.equipments:
                gone = self.equipments.pop(equipment_id)
                self.ping_history.pop(equipment_id, None)
                self.events = [e for e in self.events if e.equipment_id != equipment_id]
                try:
                    db.record_event(
                        equipment_id, gone.name, gone.ip, "removed",
                        category=gone.category, previous_status=gone.status,
                    )
                    db.delete_equipment_row(equipment_id)
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
            try:
                db.update_equipment(eq.id, monitoring_active=eq.monitoring_active)
            except Exception:
                pass
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
                try:
                    db.record_event(
                        equipment_id, eq.name, eq.ip, "down", category=eq.category,
                        previous_status=previous_status, current_status=new_status,
                        response_time_ms=response_time_ms, ts=now,
                    )
                except Exception:
                    pass

            # Recuperacao: estava offline e virou online
            elif new_status == STATUS_ONLINE and previous_status == STATUS_OFFLINE:
                eq.last_up_at = now
                downtime_seconds = None
                # encontra o ultimo evento de queda ainda aberto (sem up_at)
                for event in reversed(self.events):
                    if event.equipment_id == equipment_id and event.up_at is None:
                        event.up_at = now
                        event.duration_seconds = (now - event.down_at).total_seconds()
                        downtime_seconds = event.duration_seconds
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
                try:
                    db.record_event(
                        equipment_id, eq.name, eq.ip, "up", category=eq.category,
                        previous_status=previous_status, current_status=new_status,
                        response_time_ms=response_time_ms,
                        duration_seconds=downtime_seconds, ts=now,
                    )
                except Exception:
                    pass

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
