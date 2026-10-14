#!/usr/bin/env bash
# Backup do banco (aplicação "nfs" e n8n) e da pasta de notas. Roda no serviço "backup" do
# docker-compose.yml (imagem postgres:17), com PGHOST/PGUSER/PGPASSWORD do compose.
#
#   bash backup.sh                    espera o horário (BACKUP_HORA) e faz um backup por dia
#   bash backup.sh agora              faz um backup já
#   bash backup.sh verificar <pasta>  restaura numa base temporária e confere (sem tocar na real)
#   bash backup.sh restaurar <pasta>  SUBSTITUI os bancos pelos do backup (use ./restaurar.sh)
#
# Cada backup fica em /backups/AAAA-MM-DD_HHMM/ (nfs.dump, n8n.dump, notas.tar.gz, OK.txt) e é
# verificado logo depois: restauração completa numa base temporária. O resultado vira um evento
# "backup" no banco, que o painel mostra (aviso em Pedidos quando falha ou atrasa mais de 48 h).
# Backups com mais de BACKUP_DIAS dias são apagados.

set -euo pipefail

BACKUPS=/backups
HORA="${BACKUP_HORA:-02:30}"
export PGOPTIONS='--client-min-messages=warning'   # sem os NOTICE do dropdb --if-exists
DIAS="${BACKUP_DIAS:-30}"

log() { echo "[backup $(date '+%F %T')] $*"; }

registrar() { # registrar <ok:true|false> <detalhe json sem chaves externas>
  local saida
  saida=$(psql -qAt -d nfs -v ON_ERROR_STOP=1 -c "INSERT INTO eventos (tipo, detalhe) VALUES ('backup', '{\"ok\": $1, $2}'::jsonb)" 2>&1) \
    || log "não consegui registrar o evento no banco: $saida"
}

json_texto() { printf '%s' "$1" | tr -d '\n\r' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-300; }

contar() { # contar <banco> <tabela> → número de linhas (vazio se a tabela não existir)
  psql -qAt -d "$1" -c "SELECT count(*) FROM $2" 2>/dev/null || true
}

tabelas() { psql -qAt -d "$1" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"; }

# Restaura os dumps em bases temporárias e confere: mesmas tabelas, mesmas migrações, e as linhas
# das tabelas principais (o banco real só cresce entre o dump e a conferência).
verificar() {
  local pasta="$1" erros="" resumo=""
  for banco in nfs n8n; do
    local tmp="${banco}_verificacao"
    dropdb --if-exists "$tmp"
    createdb "$tmp"
    pg_restore --no-owner --exit-on-error -d "$tmp" "$pasta/$banco.dump" || { echo "$banco.dump não restaura"; return 1; }
    [ "$(tabelas "$tmp")" = "$(tabelas "$banco")" ] || erros+="$banco: número de tabelas diferente; "
  done
  local m_backup m_real
  m_backup=$(psql -qAt -d nfs_verificacao -c "SELECT string_agg(versao, ',' ORDER BY versao) FROM schema_migrations")
  m_real=$(psql -qAt -d nfs -c "SELECT string_agg(versao, ',' ORDER BY versao) FROM schema_migrations")
  [ "$m_backup" = "$m_real" ] || erros+="migrações diferentes; "
  for t in prestadores colaboradores pedidos eventos; do
    local b r
    b=$(contar nfs_verificacao "$t"); r=$(contar nfs "$t")
    [ -n "$b" ] && [ "$b" -le "$r" ] || erros+="$t: $b no backup, $r no banco; "
    resumo+="\"$t\": ${b:-null}, "
  done
  [ -n "$(contar n8n_verificacao workflow_entity)" ] || erros+="n8n sem a tabela de workflows; "
  tar -tzf "$pasta/notas.tar.gz" >/dev/null || erros+="notas.tar.gz ilegível; "
  dropdb --if-exists nfs_verificacao
  dropdb --if-exists n8n_verificacao
  if [ -n "$erros" ]; then
    echo "$erros"
    return 1
  fi
  echo "${resumo%, }"
}

fazer_backup() {
  local nome pasta tmp
  nome=$(date +%Y-%m-%d_%H%M)
  pasta="$BACKUPS/$nome"
  tmp="$pasta.parcial"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  log "início: $nome"
  if ! {
    pg_dump -Fc -d nfs -f "$tmp/nfs.dump" &&
    pg_dump -Fc -d n8n -f "$tmp/n8n.dump" &&
    tar -czf "$tmp/notas.tar.gz" -C /notas .
  } 2>"$tmp/erro.txt"; then
    local erro; erro=$(json_texto "$(cat "$tmp/erro.txt")")
    log "FALHOU: $erro"
    registrar false "\"pasta\": \"$nome\", \"erro\": \"$erro\""
    return 1
  fi
  local conferencia
  if ! conferencia=$(verificar "$tmp" 2>&1); then
    local erro; erro=$(json_texto "restauração de teste falhou: $conferencia")
    log "FALHOU: $erro"
    registrar false "\"pasta\": \"$nome\", \"erro\": \"$erro\""
    return 1
  fi
  rm -f "$tmp/erro.txt"
  mv "$tmp" "$pasta"
  local tamanho; tamanho=$(du -sh "$pasta" | cut -f1)
  printf 'Backup %s verificado (restauração de teste ok)\nLinhas: %s\nTamanho: %s\n' "$nome" "$conferencia" "$tamanho" >"$pasta/OK.txt"
  registrar true "\"pasta\": \"$nome\", \"tamanho\": \"$tamanho\", \"linhas\": {$conferencia}"
  log "ok: $pasta ($tamanho) · $conferencia"
  find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -mtime +"$DIAS" -exec rm -rf {} + || true
}

restaurar() {
  local pasta="$1"
  for f in nfs.dump n8n.dump; do [ -f "$pasta/$f" ] || { echo "falta $pasta/$f"; exit 1; }; done
  for banco in nfs n8n; do
    log "restaurando $banco de $pasta"
    dropdb --if-exists --force "$banco"
    createdb "$banco"
    pg_restore --no-owner --exit-on-error -d "$banco" "$pasta/$banco.dump"
  done
  log "bancos restaurados"
}

case "${1:-}" in
  agora) fazer_backup ;;
  verificar) verificar "${2:?informe a pasta do backup}" ;;
  restaurar) restaurar "${2:?informe a pasta do backup}" ;;
  "")
    log "agendado todo dia às $HORA (guarda $DIAS dias)"
    while true; do
      alvo=$(date -d "$HORA" +%s)
      [ "$alvo" -gt "$(date +%s)" ] || alvo=$(date -d "tomorrow $HORA" +%s)
      sleep $(( alvo - $(date +%s) ))
      fazer_backup || true
    done
    ;;
  *) echo "uso: backup.sh [agora | verificar <pasta> | restaurar <pasta>]"; exit 2 ;;
esac
