"""
Modelos de dados do Pingador.

Usa dataclasses simples guardadas em memoria. Se no futuro for necessario
trocar para SQLite/PostgreSQL, basta reaproveitar estas classes como
representacao dos registros e trocar a camada de persistencia em storage.py.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import itertools

# Gerador de IDs sequenciais simples (equivalente a um AUTO_INCREMENT)
_id_counter = itertools.count(1)


def next_id() -> int:
    return next(_id_counter)


# Status possiveis de um equipamento
STATUS_WAITING = "aguardando"
STATUS_ONLINE = "online"
STATUS_OFFLINE = "offline"


@dataclass
class Equipment:
    id: int
    ip: str
    name: str
    description: str
    frequency: int  # segundos entre verificacoes

    # categoria/base do equipamento (ex: aba de origem na planilha de
    # inventario, ou "Manual" quando cadastrado direto pela tela)
    category: str = "Manual"
    # origem do cadastro: "excel" (mantido em sincronia com a planilha,
    # sera atualizado/removido automaticamente) ou "manual" (cadastrado
    # pela tela, nunca tocado pela sincronizacao da planilha)
    source: str = "manual"

    monitoring_active: bool = True
    status: str = STATUS_WAITING

    last_checked: Optional[datetime] = None
    last_response_time_ms: Optional[float] = None

    down_count: int = 0
    last_down_at: Optional[datetime] = None
    last_up_at: Optional[datetime] = None

    # falhas de ping consecutivas ainda nao confirmadas como queda
    consecutive_failures: int = 0

    # controle interno do agendador (nao exposto na API)
    next_check_at: Optional[datetime] = None

    def to_dict(self):
        return {
            "id": self.id,
            "ip": self.ip,
            "name": self.name,
            "description": self.description,
            "frequency": self.frequency,
            "category": self.category,
            "source": self.source,
            "monitoring_active": self.monitoring_active,
            "status": self.status,
            "last_checked": self.last_checked.isoformat() if self.last_checked else None,
            "last_response_time_ms": self.last_response_time_ms,
            "down_count": self.down_count,
            "last_down_at": self.last_down_at.isoformat() if self.last_down_at else None,
            "last_up_at": self.last_up_at.isoformat() if self.last_up_at else None,
        }


@dataclass
class Event:
    id: int
    equipment_id: int
    previous_status: str
    current_status: str
    response_time_ms: Optional[float]
    down_at: Optional[datetime] = None
    up_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self):
        return {
            "id": self.id,
            "equipment_id": self.equipment_id,
            "previous_status": self.previous_status,
            "current_status": self.current_status,
            "response_time_ms": self.response_time_ms,
            "down_at": self.down_at.isoformat() if self.down_at else None,
            "up_at": self.up_at.isoformat() if self.up_at else None,
            "duration_seconds": self.duration_seconds,
            "timestamp": self.timestamp.isoformat(),
        }
