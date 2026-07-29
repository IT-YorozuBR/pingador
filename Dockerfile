FROM python:3.12-slim

# iputils-ping fornece o binario `ping` usado por monitor.py para checar
# os equipamentos via ICMP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PINGADOR_PORT=8000 \
    PINGADOR_EXCEL_PATH="/app/data/Inventario IP.xlsx" \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Estado (equipamentos/eventos) vive em memoria, entao um unico worker;
# threads a mais permitem atender requisicoes HTTP enquanto os pings rodam
# em background (ver monitor.py).
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "60", "app:app"]
