#!/usr/bin/env bash
# Restaura um backup (bancos e pasta de notas) por cima da instalação atual.
# Uso (nesta pasta):  ./restaurar.sh backups/2026-10-14_0230   [--sim para não perguntar]
# Tudo o que aconteceu depois do backup se perde: use só em desastre (docs/RUNBOOK.md).
set -euo pipefail
cd "$(dirname "$0")"

pasta="${1:?uso: ./restaurar.sh backups/<AAAA-MM-DD_HHMM>}"
nome=$(basename "$pasta")
[ -d "backups/$nome" ] || { echo "Não achei a pasta backups/$nome"; exit 1; }
[ -f "backups/$nome/OK.txt" ] || echo "Atenção: este backup não tem OK.txt (não foi verificado ou veio de fora)."

if [ "${2:-}" != "--sim" ]; then
  echo "Isto SUBSTITUI os pedidos, cadastros, workflows e notas pelos do backup $nome."
  echo "Tudo o que aconteceu depois dele se perde."
  read -r -p "Para continuar, digite RESTAURAR: " resposta
  [ "$resposta" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
fi

echo "== Parando o motor, o n8n e o Caddy"
docker compose stop caddy motor n8n
docker compose up -d postgres backup

echo "== Restaurando os bancos"
docker compose exec -T backup bash /scripts/backup.sh restaurar "/backups/$nome"

echo "== Restaurando a pasta de notas"
docker compose run --rm --no-deps -T --entrypoint sh motor \
  -c 'find /app/saida -mindepth 1 -delete && tar -xzf - -C /app/saida' < "backups/$nome/notas.tar.gz"

echo "== Subindo tudo de novo"
docker compose up -d
echo "Restaurado: $nome. Confira o painel e os workflows no n8n."
