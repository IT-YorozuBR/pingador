FROM python:3.12-slim

# iputils-ping fornece o binario `ping` usado por monitor.py para checar
# os equipamentos via ICMP. Ele vem setuid root no Debian, entao continua
# funcionando mesmo com o container rodando como usuario nao-root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Usuario sem privilegios: se o app for comprometido, nao e root no container.
RUN useradd --system --no-create-home --uid 10001 pingador \
    && mkdir -p /app/data/db \
    && chown -R pingador:pingador /app
USER pingador

ENV PINGADOR_PORT=8000 \
    PINGADOR_EXCEL_PATH="/app/data/Inventario IP.xlsx" \
    PINGADOR_DB_PATH="/app/data/pingador.db" \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Proxmox/Docker marcam o container como unhealthy se o app parar de responder.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/dashboard', timeout=4)" || exit 1

# O estado "ao vivo" (equipamentos/eventos) vive em memoria, entao um unico
# worker; o historico de disponibilidade e persistido em SQLite (db.py, em
# /app/data, montado como volume no compose). Threads a mais permitem
# atender requisicoes HTTP enquanto os pings rodam em background (monitor.py).
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "60", "app:app"]
