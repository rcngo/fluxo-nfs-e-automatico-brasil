// Aplica as migrações de db/migracoes/ em ordem, uma única vez cada (tabela schema_migrations).
// Uso: node db/migrar.js [--seed]     (--seed aplica também db/seeds/*.sql; só em desenvolvimento)
// Também exportado para os cenários: migrar(pool, { seed }).

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const PASTA_MIGRACOES = path.join(__dirname, 'migracoes');
const PASTA_SEEDS = path.join(__dirname, 'seeds');

const arquivosSql = (pasta) =>
  fs.existsSync(pasta) ? fs.readdirSync(pasta).filter((f) => f.endsWith('.sql')).sort() : [];

async function migrar(pool, { seed = false, log = console.log } = {}) {
  const c = await pool.connect();
  try {
    // Uma migração por vez, mesmo com vários processos subindo juntos.
    await c.query(`SELECT pg_advisory_lock(hashtext('nfs:migracoes'))`);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      versao text PRIMARY KEY,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )`);

    // Banco criado pela PoC (postgres-init aplicava o 001 direto): registra sem reaplicar.
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM schema_migrations');
    const { rows: [{ existe }] } = await c.query(`SELECT to_regclass('public.pedidos') IS NOT NULL AS existe`);
    if (n === 0 && existe) {
      await c.query(`INSERT INTO schema_migrations (versao) VALUES ('001_schema')`);
      log('banco existente da PoC: 001_schema registrada sem reaplicar');
    }

    const { rows } = await c.query('SELECT versao FROM schema_migrations');
    const aplicadas = new Set(rows.map((r) => r.versao));
    let novas = 0;
    for (const arquivo of arquivosSql(PASTA_MIGRACOES)) {
      const versao = arquivo.replace(/\.sql$/, '');
      if (aplicadas.has(versao)) continue;
      const sql = fs.readFileSync(path.join(PASTA_MIGRACOES, arquivo), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (versao) VALUES ($1)', [versao]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migração ${arquivo} falhou: ${e.message}`);
      }
      log(`aplicada ${arquivo}`);
      novas++;
    }
    if (!novas) log('nenhuma migração pendente');

    if (seed) {
      for (const arquivo of arquivosSql(PASTA_SEEDS)) {
        await c.query(fs.readFileSync(path.join(PASTA_SEEDS, arquivo), 'utf8'));
        log(`seed ${arquivo}`);
      }
    }
  } finally {
    await c.query(`SELECT pg_advisory_unlock(hashtext('nfs:migracoes'))`).catch(() => {});
    c.release();
  }
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  migrar(pool, { seed: process.argv.includes('--seed') })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { migrar };
