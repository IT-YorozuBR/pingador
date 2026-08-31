# Contexto: deploy e segurança dos sistemas na minha VM Proxmox

## Ambiente

- Tenho uma VM no Proxmox onde rodo vários sistemas em Docker, cada um com
  seu próprio `docker-compose.yml`.
- Uso **Nginx Proxy Manager (NPM)** como proxy reverso — um painel web (porta
  81) que gera configuração de Nginx e emite certificados Let's Encrypt
  automaticamente, sem eu precisar editar arquivo de config nem rodar
  certbot manualmente.
- Já tenho DNS configurado apontando subdomínios para o IP da VM.

## Sistemas que já rodam nessa VM

1. **Pingador** — MVP de monitoramento de equipamentos por IP (Flask +
   Python), dados em memória, sem banco. Roda via `gunicorn`, porta interna
   8000, mapeada para host em `127.0.0.1:8010:8000`. Tem sincronização
   automática com uma planilha Excel de inventário (`Inventario IP.xlsx`),
   montada como volume.
2. **App "4m" (checklist)** — Node.js + MongoDB. Porta interna 3020.
   Compose com serviços `4m_app` e `4m_mongodb`, rede `4m_network`.
3. **taxa-frequencia** — Node.js + Postgres + um container de cron
   (substitui um Vercel Cron, chama `/api/cron/snapshot` em dias úteis às
   22h UTC). Serviços `db`, `app`, `cron`. Porta interna do app: 3000.

## Padrão de segurança que estou aplicando em todos

- **Nenhum container publica porta direto pro host/mundo.** Só o NPM
  recebe tráfego externo (portas 80/443, e 81 só pra mim administrar).
- Cada app entra numa **rede Docker externa compartilhada** com o NPM, e no
  NPM eu aponto o "Forward Hostname/IP" pelo **nome do container** (não IP,
  não `127.0.0.1` — isso foi um erro que cometi antes, já que o NPM roda em
  container e não enxerga `127.0.0.1` do host) e a **porta interna** do
  serviço (a que está em `PORT`/`environment`, não a porta publicada no
  host).
- A rede real do NPM na minha VM é `nginx-proxy-manager_default` (achei com
  `docker network ls`) — não precisei criar uma `npm_proxy` nova, só usei
  essa como `external: true` nos compose dos outros sistemas.
- Bancos de dados (Postgres, Mongo) não publicam porta nenhuma pro host —
  só o container da aplicação fala com eles, pela rede interna do próprio
  projeto (nome do serviço como hostname).
- Credenciais via `.env` (não versionado), usando
  `${VAR:?defina VAR no .env}` em vez de defaults fracos tipo
  `${VAR:-changeme}`.
- Tabela de portas internas em uso, pra não colidir:

  | Porta interna | Sistema | Container | Rede |
  |---|---|---|---|
  | 8000 | Pingador (interna do container) | pingador | mapeada em 127.0.0.1:8010 no host |
  | 3020 | App "4m" | 4m_app | 4m_network + npm_proxy |
  | 27017 | MongoDB (4m) | 4m_mongodb | 4m_network (sem publicar porta) |
  | 3000 | taxa-frequencia app | taxa-frequencia_app | default + npm_proxy |
  | 5432 | Postgres (taxa-frequencia) | taxa-frequencia_db | default (sem publicar porta) |

## O que já foi resolvido

- Encontrei o NPM rodando (container na rede `nginx-proxy-manager_default`).
- Ajustei o `docker-compose.yml` do **app "4m"**: removi o `ports:` do
  `mongodb` e do `app` (nenhum dos dois publica porta pro host mais), e
  conectei o `app` também à rede `nginx-proxy-manager_default` (além da
  `4m_network` que já usava pra falar com o mongo), pra o NPM conseguir
  alcançar o container pelo nome (`4m_app`, porta interna `3020`).
- Decisão consciente: mantive as credenciais do Mongo com fallback
  (`${MONGO_ROOT_USER:-admin}` / `${MONGO_ROOT_PASSWORD:-changeme}`) em vez
  de forçar erro com `:?` — optei por deixar como estava por enquanto. Vale
  confirmar depois se o `.env` já sobrescreve esses valores com algo forte.
- Tive um erro de parser YAML ("found character that cannot start any
  token") ao colar um compose editado — provavelmente tab ou caractere
  invisível entrando ao colar/editar. Resolvido recriando o arquivo direto
  via `cat > docker-compose.yml << 'EOF' ... EOF` no terminal, que evita
  esse tipo de problema.

## O que falta fazer

1. Rodar `docker compose config` (valida o YAML) e `docker compose up -d
   --build` pra aplicar o compose corrigido do app "4m".
2. Cadastrar o Proxy Host do "4m" no painel do NPM: Forward Hostname/IP =
   `4m_app`, Forward Port = `3020`, com SSL (Let's Encrypt) habilitado.
3. Repetir o mesmo processo (conectar à rede do NPM, remover `ports:`,
   cadastrar Proxy Host) para o **Pingador** (container `pingador`, porta
   interna `8000`) e o **taxa-frequencia** (container do app, porta interna
   `3000` — confirmar o nome exato do container com `docker ps`, já que o
   compose dele não tem `container_name` fixo no serviço `app`).
4. Confirmar que cada domínio responde em HTTPS e que a porta interna não
   responde diretamente de fora (`curl http://ip-da-vm:porta` deve falhar).
5. Adicionar basic auth no Pingador (não tem login próprio) via NPM ou
   config adicional, já que os outros dois sistemas parecem ter
   autenticação própria.
