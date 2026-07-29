# Pingador

MVP de um sistema simples de monitoramento de equipamentos por IP, via ping.
Feito em Python + Flask, com todos os dados guardados em memoria (sem banco
de dados) para validar rapidamente o funcionamento do fluxo completo:
cadastro -> ping automatico -> dashboard -> historico de quedas.

## O que o sistema faz

- Cadastro de equipamentos (IP, nome, descricao, frequencia de verificacao).
- Ping automatico em background, respeitando a frequencia individual de
  cada equipamento (ex: um equipamento a cada 10s, outro a cada 300s).
- Dashboard com status geral, disponibilidade, cards por equipamento e
  graficos (quedas por equipamento, disponibilidade, tempo de resposta,
  linha do tempo de eventos).
- Historico de eventos de queda/recuperacao, com horario, duracao da queda
  e tempo de resposta do ping.
- Atualizacao automatica da tela via polling (JavaScript), sem precisar
  dar F5.
- Pausar/reativar o monitoramento de um equipamento e remover equipamentos.
- Sincronizacao automatica com a planilha `Inventario IP.xlsx`: cada aba
  (Servidores, Access Points, Cameras, Impressoras, Controle de Acesso,
  Rede e Seguranca, Diversos) vira uma "base"/categoria de equipamentos.
  Um IP novo na planilha e adicionado ao monitoramento sozinho; se o IP
  sumir de uma aba, o equipamento correspondente e removido. Equipamentos
  cadastrados manualmente pela tela nunca sao alterados por essa sincronia,
  mesmo que o IP tambem exista na planilha. As abas "Geral" e "Pesquisa" sao
  ignoradas (sao apenas visoes de apoio, nao listas reais de equipamentos).
  Ha um botao "Sincronizar planilha" na tela e um filtro por base/categoria.

## Como instalar

Pre-requisitos: Python 3.10+ instalado.

```bash
cd pingador
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Linux/Mac
pip install -r requirements.txt
```

## Como rodar

```bash
python app.py
```

Acesse http://127.0.0.1:5000 no navegador. O monitoramento em background
comeca a rodar automaticamente junto com o servidor.

> No Windows o `ping` usa `-n 1 -w <ms>`; no Linux/Mac usa `-c 1 -W <s>`.
> O codigo detecta o sistema operacional automaticamente (veja `monitor.py`).

## Deploy com Docker (VM Proxmox)

Pre-requisito: Docker (e docker compose) instalados na VM.

```bash
cd pingador
docker compose up -d --build
```

Acesse `http://<ip-da-vm>:8000`. A imagem inclui o `ping` do Linux (pacote
`iputils-ping`) e roda a aplicacao com `gunicorn` (1 worker, ja que os dados
vivem em memoria e nao podem ser compartilhados entre processos).

A planilha `Inventario IP.xlsx` fica montada como volume (veja
`docker-compose.yml`), entao ela pode ser editada/substituida na VM sem
precisar reconstruir a imagem — o watcher detecta a mudanca sozinho.

Se a VM estiver numa rede onde o modo bridge padrao do Docker nao alcancar os
IPs a monitorar, descomente `network_mode: host` no `docker-compose.yml`.

> Como nao ha persistencia (tudo em RAM), reiniciar o container apaga o
> historico e os equipamentos cadastrados manualmente — os vindos da
> planilha voltam sozinhos no proximo ciclo de sincronizacao.

## Como cadastrar equipamentos

1. Na tela inicial, clique em **"+ Novo equipamento"**.
2. Preencha:
   - **Nome**: identificacao do equipamento (obrigatorio).
   - **IP**: endereco IPv4/IPv6 valido (obrigatorio, validado no backend).
   - **Descricao**: texto livre (opcional).
   - **Frequencia**: intervalo em segundos entre cada verificacao
     (obrigatorio, numero inteiro >= 1).
3. Clique em **Cadastrar**. O equipamento aparece imediatamente na lista
   com status "Aguardando verificacao" ate o primeiro ping ser executado.

Erros de validacao (IP invalido, nome vazio, frequencia invalida) sao
exibidos no proprio formulario, sem quebrar a aplicacao.

## Estrutura do projeto

```
pingador/
├── app.py             # rotas Flask (paginas + API JSON)
├── models.py           # dataclasses Equipment e Event
├── storage.py           # "banco" em memoria (dicts/listas) + regras de negocio
├── monitor.py            # scheduler em background + funcao de ping cross-platform
├── excel_sync.py          # leitura e sincronizacao periodica da planilha de inventario
├── Inventario IP.xlsx      # planilha de inventario (uma aba por base/categoria)
├── requirements.txt
├── templates/
│   └── index.html         # dashboard + lista + modal de cadastro
├── static/
│   ├── css/style.css
│   └── js/dashboard.js       # polling + renderizacao + Chart.js
└── README.md
```

## Limitacoes do MVP

- **Sem persistencia**: ao reiniciar o processo Python, todos os
  equipamentos e todo o historico sao perdidos (tudo vive em RAM).
- **Sem autenticacao**: qualquer pessoa com acesso a URL pode
  cadastrar/remover equipamentos.
- **Sem alertas**: o sistema apenas registra e mostra quedas, nao envia
  notificacoes.
- **Ping simples**: um unico pacote ICMP por verificacao (sem retries,
  sem jitter/backoff).
- **Sem paginacao**: listas de equipamentos e eventos assumem volume
  pequeno (uso interno/teste).
- **Um processo unico**: nao pensado para rodar com multiplos workers
  (ex: `gunicorn -w 4`), pois o estado em memoria nao seria compartilhado
  entre processos.

## Como evoluir futuramente

O codigo ja foi organizado pensando nessa evolucao:

- `storage.py` concentra toda a logica de leitura/escrita de dados atras
  de uma unica instancia (`store`). Para trocar por banco de dados, basta
  reimplementar essa classe (por exemplo `SQLiteStore`/`PostgresStore`)
  mantendo os mesmos metodos (`add_equipment`, `list_equipments`,
  `register_ping_result`, `list_events`, etc.) — as rotas em `app.py` nao
  precisam mudar.
- `models.py` ja usa dataclasses com `to_dict()`, faceis de mapear para
  um ORM (SQLAlchemy) ou para linhas de tabela.

### Melhorias sugeridas

- **Persistencia**: SQLite para uso local (arquivo unico) ou PostgreSQL
  para ambientes compartilhados/produtivos.
- **Alertas por e-mail** quando um equipamento cair ou se recuperar.
- **Alertas no Microsoft Teams** via webhook de conector.
- **Exportacao de relatorio em CSV** do historico de eventos.
- **Historico completo por periodo** (filtros por data, paginacao).
- **Login de usuario** e controle de acesso (quem pode cadastrar/remover).
- **Integracao com Zabbix ou Grafana** (exportar metricas via API/exporter
  Prometheus, ou consumir triggers do Zabbix).
- **Retries e jitter** no ping para reduzir falsos positivos de queda.
- **WebSocket** no lugar do polling para atualizacao em tempo real.
