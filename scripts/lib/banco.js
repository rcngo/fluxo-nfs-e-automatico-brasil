// URL do Postgres para os scripts rodados na máquina (fora do Docker).
// Usa a variável indicada, se existir; senão monta a partir de infra/.env (porta 5433 do compose).

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../..');

function urlBanco(banco, variavel = 'DATABASE_URL') {
  if (process.env[variavel]) return process.env[variavel];
  const env = {};
  const arquivo = path.join(RAIZ, 'infra/.env');
  if (fs.existsSync(arquivo)) {
    for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
      const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.POSTGRES_USER) throw new Error(`defina ${variavel} ou preencha infra/.env (POSTGRES_USER/POSTGRES_PASSWORD)`);
  return `postgres://${encodeURIComponent(env.POSTGRES_USER)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:5433/${banco}`;
}

module.exports = { urlBanco };
