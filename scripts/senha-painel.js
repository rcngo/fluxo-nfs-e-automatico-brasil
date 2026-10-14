// Gera uma senha de acesso ao painel para um colaborador (a primeira, ou se ele esqueceu).
// Uso: npm run painel:senha -- <e-mail do colaborador>
// Mostra a senha uma vez; no banco fica só o hash. Depois, o colaborador troca em "Minha senha",
// e os outros colaboradores ganham senha pela tela Colaboradores do painel.

const { Pool } = require('pg');
const { urlBanco } = require('./lib/banco');
const { gerarHash, gerarSenha } = require('../motor/senha');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('uso: npm run painel:senha -- <e-mail do colaborador>');
  const pool = new Pool({ connectionString: urlBanco('nfs') });
  try {
    const senha = gerarSenha();
    const { rows: [c] } = await pool.query('UPDATE colaboradores SET senha_hash = $2 WHERE email = $1 RETURNING nome, ativo', [email, gerarHash(senha)]);
    if (!c) throw new Error(`nenhum colaborador com o e-mail ${email} (cadastre pela planilha colaboradores.csv)`);
    await pool.query('DELETE FROM sessoes WHERE colaborador_id = (SELECT id FROM colaboradores WHERE email = $1)', [email]);
    await pool.query(`INSERT INTO eventos (tipo, detalhe) VALUES ('painel', $1)`, [{ acao: 'senha gerada', email, por: 'npm run painel:senha' }]);
    console.log(`Senha de ${c.nome} (${email}): ${senha}`);
    if (!c.ativo) console.log('Atenção: este colaborador está inativo e não consegue entrar.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
