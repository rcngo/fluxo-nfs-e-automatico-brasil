#!/bin/bash
# Roda uma única vez, na criação do volume: só cria o banco da aplicação.
# As tabelas são criadas pelas migrações (db/migrar.js), executadas quando o motor sobe.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname n8n \
  -c "CREATE DATABASE ${APP_DB};"
