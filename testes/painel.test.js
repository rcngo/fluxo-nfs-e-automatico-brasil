// Teste do painel pelo HTTP, como um navegador: login, pedidos, cadastros, configurações.
// Sobe o servidor do motor (motor/http.js) com NFE.io, IA e Receita falsas num banco próprio
// (nfs_painel, recriado a cada execução). Precisa do Postgres do docker compose.
// Uso: npm run teste:painel

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepararBanco } = require('../scripts/cenarios');
const { criarMotor } = require('../motor/app');
const { criarPainel } = require('../motor/painel');
const { criarServidor } = require('../motor/http');
const { gerarHash } = require('../motor/senha');
const { relogioFalso, nfeioFalsa, brasilapiFalsa, extratorFalso } = require('../motor/falsos');

const SENHA = 'senha-de-teste-123';
const COLABORADOR = 'pedidos.exemplo@gmail.com'; // colaborador padrão do seed
const AGRO_EXEMPLO = {
  '75768426000199': {
    nome: 'AGRO EXEMPLO COMERCIO LTDA', situacao: 'ATIVA', natureza_juridica: '2062',
    endereco: { country: 'BRA', postalCode: '80010000', street: 'Rua das Flores', number: '100', district: 'Centro', city: { code: '4106902', name: 'Curitiba' }, state: 'PR' },
  },
};
const autenticado = (email) => {
  const d = email.split('@')[1];
  return `mx.google.com; dkim=pass header.i=@${d}; spf=pass smtp.mailfrom=${email}; dmarc=pass (p=NONE) header.from=${d}`;
};

let pool;
let servidor;
let base;
let motor;
let nfeio;
let n = 0;

test.before(async () => {
  pool = await prepararBanco('nfs_painel');
  await pool.query(fs.readFileSync(path.join(__dirname, '../db/seeds/poc.sql'), 'utf8'));
  await pool.query('UPDATE colaboradores SET senha_hash = $2 WHERE email = $1', [COLABORADOR, gerarHash(SENHA)]);
  await pool.query(`INSERT INTO colaboradores (nome, email, senha_hash) VALUES ('Outra', 'outra@escritorio.com', $1)`, [gerarHash(SENHA)]);
  const relogio = relogioFalso('2026-10-15T10:00:00-03:00');
  nfeio = nfeioFalsa();
  motor = criarMotor({
    db: pool, extrator: extratorFalso(), nfeio, consultarCnpj: brasilapiFalsa(AGRO_EXEMPLO), relogio,
    pastaDominio: fs.mkdtempSync(path.join(os.tmpdir(), 'nfs-painel-')), esperar: async () => {}, urlPublica: 'http://motor.teste',
  });
  servidor = criarServidor({ motor, painel: criarPainel({ db: pool, motor, nfeio, relogio }) });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// Navegador mínimo: guarda o cookie, não segue redirecionamento sozinho.
function navegador() {
  let cookie = '';
  const ir = async (caminho, { form, metodo } = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo || (form ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const novo = r.headers.get('set-cookie');
    if (novo) cookie = novo.split(';')[0];
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, local: r.headers.get('location'), tipo, html: tipo.startsWith('text/html') ? await r.text() : null, corpo: tipo.startsWith('text/html') ? null : Buffer.from(await r.arrayBuffer()), cookieHeader: novo };
  };
  return {
    ir,
    async entrar(email = COLABORADOR, senha = SENHA) {
      return ir('/painel/entrar', { form: { email, senha } });
    },
    async csrf(caminho = '/painel/pedidos') {
      const { html } = await ir(caminho);
      return html.match(/name="_csrf" value="([^"]+)"/)[1];
    },
  };
}

async function pedido(texto, de = 'cliente.exemplo@hotmail.com') {
  n++;
  return motor.processar({ canal: 'email', remetente: de, conversa_ref: `painel-${n}`, message_id: `painel-${n}`, gmail_id: `g-${n}`, texto, auth_results: autenticado(de) });
}

test('páginas exigem login; senha errada é recusada e bloqueada depois de 5 tentativas', async () => {
  const b = navegador();
  for (const caminho of ['/painel', '/painel/pedidos', '/painel/empresas', '/painel/configuracoes']) {
    const r = await b.ir(caminho);
    assert.strictEqual(r.status, 303, caminho);
    assert.strictEqual(r.local, '/painel/entrar');
  }
  assert.strictEqual((await b.ir('/painel/configuracoes', { form: { emissao_habilitada: '' } })).status, 401);
  assert.strictEqual((await b.entrar(COLABORADOR, 'errada')).status, 401);
  for (let i = 0; i < 5; i++) await b.entrar('outra@escritorio.com', 'errada');
  const bloqueado = await b.entrar('outra@escritorio.com', SENHA); // até a certa é recusada durante o bloqueio
  assert.strictEqual(bloqueado.status, 429);
  assert.match(bloqueado.html, /Muitas tentativas/);
});

test('login cria sessão com cookie HttpOnly/SameSite; senha guardada só como hash; sair encerra', async () => {
  const b = navegador();
  const r = await b.entrar();
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.local, '/painel/pedidos');
  assert.match(r.cookieHeader, /HttpOnly/);
  assert.match(r.cookieHeader, /SameSite=Strict/);
  const { rows: [c] } = await pool.query('SELECT senha_hash FROM colaboradores WHERE email = $1', [COLABORADOR]);
  assert.match(c.senha_hash, /^scrypt\$\d+\$/);
  assert.ok(!c.senha_hash.includes(SENHA));
  const { rows: [s] } = await pool.query('SELECT token_hash FROM sessoes LIMIT 1');
  assert.match(s.token_hash, /^[0-9a-f]{64}$/); // só o hash do token

  const csrf = await b.csrf();
  assert.strictEqual((await b.ir('/painel/sair', { form: { _csrf: csrf } })).local, '/painel/entrar');
  assert.strictEqual((await b.ir('/painel/pedidos')).status, 303); // sessão encerrada
});

test('filtrar encaminhados, abrir o pedido e marcar como resolvido (critério 1)', async () => {
  await pool.query('UPDATE prestadores SET exige_confirmacao = false');
  const r = await pedido('Nota de R$ 60.000,00 para 75.768.426/0001-99, programação de setembro. <script>alert(1)</script>');
  assert.strictEqual(r.encaminhar.motivo, 'valor_fora_da_faixa');

  const b = navegador();
  await b.entrar();
  const lista = await b.ir('/painel/pedidos');
  assert.match(lista.html, /pedido\(s\) com o escritório aguardando resolução/);
  const filtrada = await b.ir('/painel/pedidos?estado=ENCAMINHADO');
  assert.match(filtrada.html, new RegExp(r.pedido_id.slice(0, 8)));
  assert.match(filtrada.html, /valor fora da faixa/);
  assert.doesNotMatch((await b.ir('/painel/pedidos?estado=EMITIDA')).html, new RegExp(r.pedido_id.slice(0, 8)));

  const detalhe = await b.ir(`/painel/pedidos/${r.pedido_id}`);
  assert.strictEqual(detalhe.status, 200);
  assert.match(detalhe.html, /Com o escritório/);
  assert.match(detalhe.html, /Marcar como resolvido/);
  assert.match(detalhe.html, /AGRO EXEMPLO COMERCIO LTDA/);
  assert.match(detalhe.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); // mensagem do cliente escapada
  assert.doesNotMatch(detalhe.html, /<script>alert/);

  // Sem o token CSRF, o formulário é recusado.
  assert.strictEqual((await b.ir(`/painel/pedidos/${r.pedido_id}/resolver`, { form: { numero_nota: '1' } })).status, 403);
  const csrf = detalhe.html.match(/name="_csrf" value="([^"]+)"/)[1];
  const resolvido = await b.ir(`/painel/pedidos/${r.pedido_id}/resolver`, { form: { _csrf: csrf, numero_nota: '4321', observacao: 'emitida no portal' } });
  assert.strictEqual(resolvido.status, 303);
  const depois = await b.ir(resolvido.local);
  assert.match(depois.html, /Pedido marcado como resolvido/);
  assert.match(depois.html, /Resolvido pelo escritório/);
  assert.match(depois.html, /painel: pedidos.exemplo@gmail\.com · nota 4321/);
  assert.doesNotMatch(depois.html, /<button type="submit">Marcar como resolvido/);
  const { rows: [p] } = await pool.query('SELECT estado FROM pedidos WHERE id = $1', [r.pedido_id]);
  assert.strictEqual(p.estado, 'RESOLVIDO_MANUAL');
  // Segunda vez: avisa.
  assert.match((await b.ir((await b.ir(`/painel/pedidos/${r.pedido_id}/resolver`, { form: { _csrf: csrf } })).local)).html, /já tinha sido marcado/);
});

test('cadastrar uma empresa pela tela e um pedido dela ser emitido (critério 2)', async () => {
  const b = navegador();
  await b.entrar();
  const csrf = await b.csrf('/painel/empresas');

  const invalida = await b.ir('/painel/empresas', { form: { _csrf: csrf, cnpj: '74.865.958/0001-82', razao_social: 'X', nfeio_company_id: 'x', municipio_ibge: '3550308', valor_maximo: '1000' } });
  assert.strictEqual(invalida.status, 400);
  assert.match(invalida.html, /CNPJ inválido/);

  const criada = await b.ir('/painel/empresas', { form: {
    _csrf: csrf, cnpj: '74.865.958/0001-81', razao_social: 'EMPRESA DO PAINEL LTDA', nfeio_company_id: 'empresa-do-painel',
    municipio_ibge: '3550308', valor_minimo: '10,00', valor_maximo: '20.000,00', ativo: '1',
  } });
  assert.strictEqual(criada.status, 303);
  const empresaUrl = criada.local.split('?')[0];
  const id = empresaUrl.split('/').pop();
  assert.match((await b.ir(criada.local)).html, /EMPRESA DO PAINEL LTDA/);

  const servico = await b.ir(`${empresaUrl}/servicos`, { form: { _csrf: csrf, apelido: 'Programação', descricao_padrao: 'Desenvolvimento de software', city_service_code: '010201', federal_service_code: '010201', nbs_code: '115021000' } });
  assert.strictEqual(servico.status, 303);
  assert.strictEqual((await b.ir(`${empresaUrl}/remetentes`, { form: { _csrf: csrf, canal: 'email', identificador: 'Financeiro@EmpresaPainel.com.br', nome: 'Financeiro' } })).status, 303);
  const telInvalido = await b.ir(`${empresaUrl}/remetentes`, { form: { _csrf: csrf, canal: 'whatsapp', identificador: '1234' } });
  assert.match(telInvalido.html, /Telefone inválido/);
  assert.strictEqual((await b.ir(`${empresaUrl}/remetentes`, { form: { _csrf: csrf, canal: 'whatsapp', identificador: '(64) 99999-1111' } })).status, 303);
  const pag = await b.ir(empresaUrl);
  assert.match(pag.html, /financeiro@empresapainel\.com\.br/);
  assert.match(pag.html, /\+5564999991111/);

  const r = await pedido('Nota de R$ 1.500,00 para 75.768.426/0001-99, programação de setembro.', 'financeiro@empresapainel.com.br');
  const nota = nfeio.emissoes[nfeio.emissoes.length - 1];
  assert.ok(r.anexos && r.anexos.length, JSON.stringify(r).slice(0, 300));
  assert.strictEqual(nota.companyId, 'empresa-do-painel');
  assert.strictEqual(nota.payload.servicesAmount, 1500);
  assert.match(nota.payload.description, /^Desenvolvimento de software/);

  // O PDF e o XML da nota pelo painel.
  const pdf = await b.ir(`/painel/pedidos/${r.pedido_id}/nota.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.tipo, 'application/pdf');
  assert.match(pdf.corpo.toString(), /^%PDF/);
  assert.strictEqual((await b.ir(`/painel/pedidos/${r.pedido_id}/nota.xml`)).tipo, 'application/xml');

  const { rows } = await pool.query(`SELECT detalhe->>'acao' AS acao, detalhe->>'por' AS por FROM eventos WHERE tipo = 'painel' AND (detalhe->>'empresa_id' = $1 OR detalhe->>'empresa' = '74865958000181') ORDER BY id`, [id]);
  assert.deepStrictEqual(rows.map((e) => e.acao), ['empresa criada', 'serviço criado', 'remetente adicionado', 'remetente adicionado']);
  assert.ok(rows.every((e) => e.por === COLABORADOR));
});

test('configurações: desligar a emissão pelo painel vale para o próximo pedido e fica registrado', async () => {
  const b = navegador();
  await b.entrar();
  const csrf = await b.csrf('/painel/configuracoes');
  const invalido = await b.ir('/painel/configuracoes', { form: { _csrf: csrf, prazo_resposta_dias_uteis: '0', max_rodadas_perguntas: '2', prazo_emissor_horas: '4' } });
  assert.strictEqual(invalido.status, 400);
  const r = await b.ir('/painel/configuracoes', { form: { _csrf: csrf, prazo_resposta_dias_uteis: '3', max_rodadas_perguntas: '2', prazo_emissor_horas: '4', email_somente_remetentes_cadastrados: '1' } });
  assert.strictEqual(r.status, 303);
  const { rows } = await pool.query(`SELECT chave, valor FROM config WHERE chave IN ('emissao_habilitada', 'prazo_resposta_dias_uteis')`);
  assert.deepStrictEqual(Object.fromEntries(rows.map((c) => [c.chave, c.valor])), { emissao_habilitada: false, prazo_resposta_dias_uteis: 3 });
  const { rows: [e] } = await pool.query(`SELECT detalhe FROM eventos WHERE tipo = 'painel' AND detalhe->>'acao' = 'configuração alterada' ORDER BY id DESC LIMIT 1`);
  assert.deepStrictEqual(e.detalhe.emissao_habilitada, { de: true, para: false });

  const p = await pedido('Nota de R$ 800,00 para 75.768.426/0001-99, programação de setembro.');
  assert.strictEqual(p.encaminhar.motivo, 'emissao_desligada');
  await b.ir('/painel/configuracoes', { form: { _csrf: csrf, emissao_habilitada: '1', prazo_resposta_dias_uteis: '2', max_rodadas_perguntas: '2', prazo_emissor_horas: '4', email_somente_remetentes_cadastrados: '1' } });
});

test('instalação: modo de emissão e aviso de backup atrasado ou com falha', async () => {
  const b = navegador();
  await b.entrar();
  let cfg = await b.ir('/painel/configuracoes');
  assert.match(cfg.html, /somente de teste/);
  assert.match(cfg.html, /nenhum registrado/);
  assert.doesNotMatch((await b.ir('/painel/pedidos')).html, /backup diário está atrasado/);

  // relógio falso em 15/10/2026 10:00: backup de ontem ok, sem aviso; depois uma falha, com aviso.
  await pool.query(`INSERT INTO eventos (tipo, detalhe, criado_em) VALUES ('backup', '{"ok": true}', '2026-10-15T02:30:00-03:00')`);
  assert.doesNotMatch((await b.ir('/painel/pedidos')).html, /backup diário está atrasado/);
  await pool.query(`INSERT INTO eventos (tipo, detalhe, criado_em) VALUES ('backup', '{"ok": false, "erro": "disco cheio"}', '2026-10-15T03:00:00-03:00')`);
  assert.match((await b.ir('/painel/pedidos')).html, /backup diário está atrasado ou falhou/);
  cfg = await b.ir('/painel/configuracoes');
  assert.match(cfg.html, /última tentativa falhou .*disco cheio/);
  await pool.query(`DELETE FROM eventos WHERE tipo = 'backup'`);
});

test('colaboradores: novo colaborador, padrão único, senha gerada uma vez, troca de senha', async () => {
  const b = navegador();
  await b.entrar();
  const csrf = await b.csrf('/painel/colaboradores');
  assert.strictEqual((await b.ir('/painel/colaboradores', { form: { _csrf: csrf, nome: 'Ana', email: 'Ana@Escritorio.com', padrao: '1' } })).status, 303);
  const { rows } = await pool.query('SELECT email FROM colaboradores WHERE padrao');
  assert.deepStrictEqual(rows.map((r) => r.email), ['ana@escritorio.com']);
  const { rows: [ana] } = await pool.query(`SELECT id FROM colaboradores WHERE email = 'ana@escritorio.com'`);
  const gerada = await b.ir(`/painel/colaboradores/${ana.id}/senha`, { form: { _csrf: csrf } });
  const senhaAna = gerada.html.match(/<code style="font-size:16px">([^<]+)<\/code>/)[1];
  const outra = navegador();
  assert.strictEqual((await outra.entrar('ana@escritorio.com', senhaAna)).status, 303);
  const csrfAna = await outra.csrf('/painel/senha');
  assert.match((await outra.ir('/painel/senha', { form: { _csrf: csrfAna, atual: senhaAna, nova: 'curta', repetida: 'curta' } })).html, /pelo menos 10/);
  assert.strictEqual((await outra.ir('/painel/senha', { form: { _csrf: csrfAna, atual: senhaAna, nova: 'nova-senha-da-ana', repetida: 'nova-senha-da-ana' } })).status, 303);
  assert.strictEqual((await navegador().entrar('ana@escritorio.com', 'nova-senha-da-ana')).status, 303);
  // Não dá para desativar o próprio acesso.
  const { rows: [eu] } = await pool.query('SELECT id FROM colaboradores WHERE email = $1', [COLABORADOR]);
  assert.match((await b.ir(`/painel/colaboradores/${eu.id}`, { form: { _csrf: csrf, nome: 'Eu' } })).html, /próprio acesso/);
});
