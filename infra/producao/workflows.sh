#!/usr/bin/env bash
# Gera os workflows do n8n com os IDs das credenciais desta instalação e importa no n8n.
# Uso (nesta pasta):
#   ./workflows.sh --gmail <id da credencial Gmail> --alerta <e-mail reserva para erros>
#                  [--whatsapp-cred <id da credencial WhatsApp> --whatsapp-numero <Phone number ID>]
# Os workflows chegam DESATIVADOS: ativar no editor do n8n (docs/INSTALACAO.md).
# Rodar de novo substitui os workflows pelos novos (mesmo ID).
set -euo pipefail
cd "$(dirname "$0")"
[ "$#" -gt 0 ] || { sed -n '2,7p' "$0"; exit 1; }

docker compose exec -T motor sh -c 'rm -rf /tmp/workflows'
docker compose exec -T motor node n8n/workflows/gerar_workflows.js "$@" --saida /tmp/workflows >/dev/null

for wf in nfs_erros nfs_email nfs_whatsapp; do
  docker compose exec -T motor test -f "/tmp/workflows/$wf.json" || continue
  echo "== importando $wf"
  docker compose exec -T motor cat "/tmp/workflows/$wf.json" \
    | docker compose exec -T n8n sh -c "cat > /tmp/$wf.json && n8n import:workflow --input=/tmp/$wf.json && rm /tmp/$wf.json"
done
echo "Importados. Abra o n8n e ative: NFS - E-mail$(docker compose exec -T motor test -f /tmp/workflows/nfs_whatsapp.json && echo ' e NFS - WhatsApp')."
