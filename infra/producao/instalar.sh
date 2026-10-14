#!/usr/bin/env bash
# Instalação no servidor do escritório. Rodar nesta pasta: ./instalar.sh
#
# Na primeira vez: pergunta o domínio e as chaves, gera as senhas internas, cria o .env e o
# secrets.env, sobe tudo (as migrações rodam quando o motor sobe) e cadastra o primeiro
# colaborador com a senha do painel. Rodar de novo não apaga nada: só reconstrói e sobe.
#
# Sem perguntas (automação): defina as variáveis antes, por exemplo
#   DOMINIO=nfs.exemplo.com.br EMAIL_ACME=ti@exemplo.com.br ANTHROPIC_API_KEY=... NFEIO_API_KEY=... \
#   COLABORADOR_NOME="Maria" COLABORADOR_EMAIL=maria@exemplo.com.br ./instalar.sh
# Opcionais: WHATSAPP_APP_SECRET, HTTP_PORTA, HTTPS_PORTA, N8N_PORTA_LOCAL (só para testes).
#
# Servidor novo que vai receber um backup: ./instalar.sh --para-restaurar (não cadastra o primeiro
# colaborador; a restauração traz os cadastros). Ver docs/RUNBOOK.md, "Restaurar um backup".
#
# Guia completo: docs/INSTALACAO.md
set -euo pipefail
cd "$(dirname "$0")"
PARA_RESTAURAR=false
[ "${1:-}" = "--para-restaurar" ] && PARA_RESTAURAR=true

passo() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
erro() { printf '\033[31mErro: %s\033[0m\n' "$*" >&2; exit 1; }

perguntar() { # perguntar <variável> <texto> [secreto]
  local var="$1" texto="$2" valor="${!1:-}"
  while [ -z "$valor" ]; do
    if [ "${3:-}" = secreto ]; then read -r -s -p "$texto: " valor; echo; else read -r -p "$texto: " valor; fi
  done
  printf -v "$var" '%s' "$valor"
}

passo "Conferindo o servidor"
command -v docker >/dev/null || erro "Docker não está instalado (docs/INSTALACAO.md, passo 1)."
docker compose version >/dev/null 2>&1 || erro "Falta o Docker Compose v2 (comando 'docker compose')."
docker info >/dev/null 2>&1 || erro "O Docker não está rodando, ou este usuário não tem permissão (use sudo ou o grupo docker)."
command -v openssl >/dev/null || erro "Falta o openssl (sudo apt install openssl)."
echo "ok"

if [ -f .env ]; then
  passo "Configuração já existe (.env): mantendo as senhas e chaves atuais"
else
  passo "Configuração"
  echo "Domínio: o endereço que o escritório criou para o sistema (ex.: nfs.seuescritorio.com.br)."
  echo "Ele já deve apontar para o IP deste servidor (registro DNS do tipo A)."
  perguntar DOMINIO "Domínio"
  perguntar EMAIL_ACME "E-mail para avisos do certificado HTTPS (Let's Encrypt)"
  perguntar ANTHROPIC_API_KEY "Chave da API da Anthropic (sk-ant-...)" secreto
  perguntar NFEIO_API_KEY "Chave da API da NFE.io" secreto
  if [ -z "${WHATSAPP_APP_SECRET+x}" ]; then
    read -r -s -p "App Secret do app na Meta (WhatsApp; Enter para deixar para depois): " WHATSAPP_APP_SECRET; echo
  fi

  url="https://$DOMINIO"
  [ "${HTTPS_PORTA:-443}" = 443 ] || url="$url:$HTTPS_PORTA"

  umask 077
  cat > .env <<EOF
# Gerado por instalar.sh em $(date '+%d/%m/%Y %H:%M'). GUARDE UMA CÓPIA em local seguro (cofre de senhas):
# sem a N8N_ENCRYPTION_KEY, as credenciais do n8n (Gmail, WhatsApp) não abrem num servidor novo.
DOMINIO=$DOMINIO
EMAIL_ACME=$EMAIL_ACME
URL_PUBLICA=$url
POSTGRES_USER=nfs
POSTGRES_PASSWORD=$(openssl rand -hex 24)
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
HTTP_PORTA=${HTTP_PORTA:-80}
HTTPS_PORTA=${HTTPS_PORTA:-443}
N8N_PORTA_LOCAL=${N8N_PORTA_LOCAL:-5678}
BACKUP_HORA=02:30
BACKUP_DIAS=30

# Emissão REAL (NFE.io Production). Só com a decisão formal do escritório: docs/RUNBOOK.md.
EMISSAO_PRODUCAO_HABILITADA=false
EMISSAO_PRODUCAO_DECISAO=
EOF
  cat > secrets.env <<EOF
# Chaves das APIs, lidas pelo motor. Gerado por instalar.sh; guarde uma cópia junto com o .env.
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
NFEIO_API_KEY=$NFEIO_API_KEY
# WhatsApp (Cloud API): App Secret do app na Meta e o token de verificação do webhook
# (o token foi gerado aqui; é o mesmo que se digita na configuração do webhook na Meta).
WHATSAPP_APP_SECRET=${WHATSAPP_APP_SECRET:-}
WHATSAPP_VERIFY_TOKEN=$(openssl rand -hex 16)
EOF
  umask 022
  echo "Criados .env e secrets.env (só o dono do arquivo consegue ler)."
fi

mkdir -p backups cadastro

passo "Construindo e subindo os serviços (a primeira vez demora alguns minutos)"
docker compose up -d --build

passo "Esperando o motor ficar pronto"
for i in $(seq 1 60); do
  if docker compose exec -T motor wget -qO- http://127.0.0.1:3000/saude >/dev/null 2>&1; then echo "ok"; break; fi
  [ "$i" = 60 ] && { docker compose logs --tail 40 motor; erro "o motor não respondeu em 3 minutos (veja o log acima)."; }
  sleep 3
done

set -a; . ./.env; set +a
psql_nfs() { docker compose exec -T postgres psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d nfs "$@"; }

if [ "$PARA_RESTAURAR" = false ] && [ "$(psql_nfs -c 'SELECT count(*) FROM colaboradores')" = 0 ]; then
  passo "Primeiro colaborador (recebe os encaminhamentos e entra no painel)"
  perguntar COLABORADOR_NOME "Nome"
  perguntar COLABORADOR_EMAIL "E-mail"
  COLABORADOR_EMAIL=$(printf '%s' "$COLABORADOR_EMAIL" | tr '[:upper:]' '[:lower:]')
  # Pelo stdin: o psql só substitui :'variável' (com aspas seguras) em comandos lidos, não no -c.
  echo "INSERT INTO colaboradores (nome, email, padrao) VALUES (:'nome', :'email', true);" \
    | psql_nfs -v nome="$COLABORADOR_NOME" -v email="$COLABORADOR_EMAIL" >/dev/null
  docker compose exec -T motor node scripts/senha-painel.js "$COLABORADOR_EMAIL"
  echo "Anote a senha acima: ela não aparece de novo (dá para trocar no painel, em Minha senha)."
fi

passo "Pronto"
cat <<EOF
Painel do escritório: $URL_PUBLICA/painel
(o certificado HTTPS é emitido no primeiro acesso; pode levar um minuto)

Próximos passos (docs/INSTALACAO.md):
  1. Abrir o editor do n8n por túnel SSH e criar a conta de administrador.
  2. Criar a credencial do Gmail no n8n e importar os workflows:  ./workflows.sh --gmail <id> --alerta <e-mail>
  3. Cadastrar empresas, serviços e remetentes (pelo painel ou por planilha).
  4. Copiar o .env e o secrets.env para o cofre de senhas do escritório.
A emissão real continua DESLIGADA: as notas saem só no ambiente de testes da NFE.io.
EOF
