// Painel do escritório (/painel): pedidos, cadastros e configurações, com login dos colaboradores.
// Páginas simples servidas pelo próprio motor (HTML em painel-html.js). Toda mudança de
// cadastro ou configuração gera evento (tipo "painel") com quem fez.
//
// Segurança: senha com scrypt (senha.js); sessão por cookie HttpOnly + SameSite=Strict com o
// token guardado só como hash; token CSRF em todo formulário; 5 senhas erradas seguidas
// bloqueiam o e-mail por 15 minutos.

const crypto = require('node:crypto');
const { cnpjValido } = require('../n8n/decidir');
const { digitos, reaisParaCentavos, telefone, emailValido } = require('./cadastro');
const { gerarHash, conferir, gerarSenha } = require('./senha');
const { MOTIVOS } = require('./encaminhamento');
const html = require('./painel-html');

const COOKIE = 'nfs_sessao';
const DURACAO_SESSAO_MS = 12 * 3_600_000;
const MAX_FALHAS = 5;
const BLOQUEIO_MS = 15 * 60_000;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AVISOS = {
  salvo: 'Alterações salvas.',
  adicionado: 'Adicionado.',
  resolvido: 'Pedido marcado como resolvido.',
  ja_resolvido: 'Este pedido já tinha sido marcado como resolvido.',
  nao_encaminhado: 'Este pedido não está com o escritório.',
  senha: 'Senha trocada.',
};

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.db
 * @param {object} deps.motor       criarMotor() (resolverPedido)
 * @param {object} deps.nfeio       para baixar o PDF e o XML da nota
 * @param {{ agora(): Date }} deps.relogio
 * @param {boolean} [deps.cookieSeguro]  cookie só por HTTPS (produção)
 */
// instalacao: { producao, decisao } — se a emissão real foi liberada na instalação (motor/nfeio.js).
function criarPainel({ db, motor, nfeio, relogio, cookieSeguro = false, instalacao = { producao: false, decisao: '' } }) {
  const falhasLogin = new Map(); // e-mail → { n, ate }

  // -------------------------------------------------------------------------
  // Resposta
  // -------------------------------------------------------------------------

  const cabecalhos = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' };
  const pagina = (res, status, corpo, extra = {}) => {
    res.writeHead(status, { ...cabecalhos, 'Content-Type': 'text/html; charset=utf-8', ...extra });
    res.end(corpo);
  };
  const ir = (res, destino, extra = {}) => {
    res.writeHead(303, { ...cabecalhos, Location: destino, ...extra });
    res.end();
  };
  const cookie = (valor, maxAge) => `${COOKIE}=${valor}; Path=/painel; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSeguro ? '; Secure' : ''}`;

  async function evento(sessao, acao, detalhe = {}) {
    await db.query(`INSERT INTO eventos (pedido_id, tipo, detalhe, criado_em) VALUES ($1, 'painel', $2, $3)`, [
      detalhe.pedido_id || null, { acao, por: sessao.email, ...detalhe }, relogio.agora(),
    ]);
  }

  // -------------------------------------------------------------------------
  // Sessão
  // -------------------------------------------------------------------------

  function lerCookie(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
    return m ? m[1] : null;
  }

  async function sessaoAtual(req) {
    const token = lerCookie(req);
    if (!token) return null;
    const { rows: [s] } = await db.query(
      `SELECT s.csrf, c.id, c.nome, c.email FROM sessoes s JOIN colaboradores c ON c.id = s.colaborador_id
       WHERE s.token_hash = $1 AND s.expira_em > $2 AND c.ativo AND c.senha_hash IS NOT NULL`,
      [hash(token), relogio.agora()],
    );
    return s ? { ...s, token } : null;
  }

  async function entrar(req, res, form) {
    const email = String(form.get('email') || '').trim().toLowerCase();
    const agora = relogio.agora().getTime();
    const f = falhasLogin.get(email);
    if (f && f.n >= MAX_FALHAS && f.ate > agora) {
      return pagina(res, 429, html.paginaLogin({ erro: 'Muitas tentativas. Tente de novo em 15 minutos.', email }));
    }
    const { rows: [c] } = await db.query('SELECT id, senha_hash FROM colaboradores WHERE email = $1 AND ativo', [email]);
    if (!c || !c.senha_hash || !conferir(String(form.get('senha') || ''), c.senha_hash)) {
      const n = f && f.ate > agora ? f.n + 1 : 1;
      falhasLogin.set(email, { n, ate: agora + BLOQUEIO_MS });
      return pagina(res, 401, html.paginaLogin({ erro: 'E-mail ou senha incorretos.', email }));
    }
    falhasLogin.delete(email);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query('DELETE FROM sessoes WHERE expira_em < $1', [relogio.agora()]);
    await db.query('INSERT INTO sessoes (token_hash, colaborador_id, csrf, criado_em, expira_em) VALUES ($1, $2, $3, $4, $5)', [
      hash(token), c.id, crypto.randomBytes(24).toString('base64url'), relogio.agora(), new Date(agora + DURACAO_SESSAO_MS),
    ]);
    return ir(res, '/painel/pedidos', { 'Set-Cookie': cookie(token, DURACAO_SESSAO_MS / 1000) });
  }

  // -------------------------------------------------------------------------
  // Pedidos
  // -------------------------------------------------------------------------

  async function numerosDoMes() {
    const agora = relogio.agora();
    const { rows: [n] } = await db.query(
      `WITH inicio AS (SELECT (date_trunc('month', $1::timestamptz AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS t)
       SELECT
         count(*) FILTER (WHERE p.criado_em >= inicio.t AND p.motivo IS DISTINCT FROM 'mensagem não é pedido de nota') AS pedidos,
         count(*) FILTER (WHERE p.criado_em >= inicio.t AND p.estado IN ('EMITIDA','ENTREGUE')) AS emitidas,
         count(*) FILTER (WHERE p.estado = 'ENCAMINHADO') AS pendentes,
         count(*) FILTER (WHERE p.criado_em >= inicio.t AND p.estado = 'RESOLVIDO_MANUAL') AS resolvidos
       FROM pedidos p, inicio`,
      [agora],
    );
    const { rows: motivos } = await db.query(
      `SELECT motivo, count(DISTINCT pedido_id)::int AS n FROM encaminhamentos
       WHERE motivo <> 'nova_mensagem' AND criado_em >= (date_trunc('month', $1::timestamptz AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
       GROUP BY motivo ORDER BY n DESC`,
      [agora],
    );
    return {
      pedidos: Number(n.pedidos), emitidas: Number(n.emitidas), pendentes: Number(n.pendentes), resolvidos: Number(n.resolvidos),
      motivos: motivos.map((m) => ({ titulo: (MOTIVOS[m.motivo] || [m.motivo])[0], n: m.n })),
    };
  }

  // Backup diário (infra/producao/backup.sh registra um evento "backup" a cada execução).
  // Atrasado: a última execução falhou ou a última que deu certo tem mais de 48 h. Sem nenhum
  // evento (máquina de desenvolvimento, sem o serviço de backup), não há aviso.
  async function situacaoBackup() {
    const { rows: [ultimo] } = await db.query(`SELECT criado_em, detalhe FROM eventos WHERE tipo = 'backup' ORDER BY criado_em DESC LIMIT 1`);
    if (!ultimo) return null;
    const { rows: [bom] } = await db.query(`SELECT criado_em, detalhe FROM eventos WHERE tipo = 'backup' AND detalhe->>'ok' = 'true' ORDER BY criado_em DESC LIMIT 1`);
    const atrasado = ultimo.detalhe.ok !== true || !bom || relogio.agora() - bom.criado_em > 48 * 3600 * 1000;
    return { ultimo, bom, atrasado };
  }

  async function listaPedidos(ctx, res, url) {
    const q = url.searchParams;
    const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
    const filtros = {
      estado: html.ESTADOS[q.get('estado')] ? q.get('estado') : '',
      empresa: UUID.test(q.get('empresa') || '') ? q.get('empresa') : '',
      de: data(q.get('de')),
      ate: data(q.get('ate')),
    };
    const { rows: pedidos } = await db.query(
      `SELECT p.id, p.criado_em, p.estado, p.canal, p.remetente, p.valor_centavos, p.tomador_documento,
              p.dados->'tomador'->>'nome' AS tomador, pr.razao_social AS empresa,
              (SELECT e.motivo FROM encaminhamentos e WHERE e.pedido_id = p.id AND e.motivo <> 'nova_mensagem' ORDER BY e.criado_em DESC LIMIT 1) AS motivo_enc
       FROM pedidos p LEFT JOIN prestadores pr ON pr.id = p.prestador_id
       WHERE ($1::text = '' OR p.estado::text = $1)
         AND ($2::text = '' OR p.prestador_id::text = $2)
         AND ($3::text = '' OR (p.criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $3::date)
         AND ($4::text = '' OR (p.criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $4::date)
       ORDER BY (p.estado = 'ENCAMINHADO') DESC, p.criado_em DESC LIMIT 200`,
      [filtros.estado, filtros.empresa, filtros.de, filtros.ate],
    );
    for (const p of pedidos) {
      if (p.estado === 'ENCAMINHADO' && p.motivo_enc) p.motivo_encaminhamento = (MOTIVOS[p.motivo_enc] || [p.motivo_enc])[0];
    }
    const { rows: empresas } = await db.query('SELECT id, razao_social FROM prestadores ORDER BY razao_social');
    const numeros = await numerosDoMes();
    const backup = await situacaoBackup();
    return pagina(res, 200, html.paginaPedidos(ctx, { pedidos, filtros, empresas, numeros, pendentes: filtros.estado === 'ENCAMINHADO' ? 0 : numeros.pendentes, backupAtrasado: Boolean(backup && backup.atrasado) }));
  }

  async function verPedido(ctx, res, id) {
    const { rows: [pedido] } = await db.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido) return pagina(res, 404, html.paginaErro(ctx, 404, 'Pedido não encontrado'));
    const { rows: [empresa] } = pedido.prestador_id ? await db.query('SELECT razao_social, cnpj FROM prestadores WHERE id = $1', [pedido.prestador_id]) : { rows: [] };
    const { rows: mensagens } = await db.query('SELECT direcao, conteudo, criado_em FROM mensagens WHERE pedido_id = $1 ORDER BY criado_em', [id]);
    const { rows: eventos } = await db.query('SELECT tipo, estado_de, estado_para, detalhe, criado_em FROM eventos WHERE pedido_id = $1 ORDER BY id', [id]);
    const { rows: encaminhamentos } = await db.query('SELECT * FROM encaminhamentos WHERE pedido_id = $1 ORDER BY criado_em', [id]);
    return pagina(res, 200, html.paginaPedido(ctx, { pedido, empresa, mensagens, eventos, encaminhamentos }));
  }

  async function arquivoNota(ctx, res, id, formato) {
    const { rows: [p] } = await db.query(
      `SELECT p.nfeio_invoice_id, pr.nfeio_company_id FROM pedidos p JOIN prestadores pr ON pr.id = p.prestador_id
       WHERE p.id = $1 AND p.nfeio_invoice_id IS NOT NULL AND p.estado IN ('EMITIDA','ENTREGUE')`,
      [id],
    );
    if (!p) return pagina(res, 404, html.paginaErro(ctx, 404, 'Nota não encontrada'));
    const arquivo = await nfeio.baixar(p.nfeio_company_id, p.nfeio_invoice_id, formato);
    res.writeHead(200, {
      ...cabecalhos,
      'Content-Type': formato === 'pdf' ? 'application/pdf' : 'application/xml',
      'Content-Disposition': `inline; filename="nota-${p.nfeio_invoice_id}.${formato}"`,
    });
    return res.end(arquivo);
  }

  async function resolver(ctx, res, id, form) {
    const r = await motor.resolverPedido(id, {
      quem: ctx.colaborador.email,
      numero_nota: String(form.get('numero_nota') || '').trim().slice(0, 50),
      observacao: String(form.get('observacao') || '').trim().slice(0, 1000),
    });
    if (r.status === 'invalido') return pagina(res, 404, html.paginaErro(ctx, 404, 'Pedido não encontrado'));
    return ir(res, `/painel/pedidos/${id}?aviso=${r.status}`);
  }

  // -------------------------------------------------------------------------
  // Cadastros
  // -------------------------------------------------------------------------

  const marcado = (form, nome) => form.get(nome) === '1';

  function lerEmpresa(form) {
    const e = {
      cnpj: digitos(form.get('cnpj')),
      razao_social: String(form.get('razao_social') || '').trim(),
      nfeio_company_id: String(form.get('nfeio_company_id') || '').trim(),
      municipio_ibge: digitos(form.get('municipio_ibge')),
      valor_min_centavos: reaisParaCentavos(form.get('valor_minimo')) ?? 1,
      valor_max_centavos: reaisParaCentavos(form.get('valor_maximo')),
      colaborador_id: UUID.test(form.get('colaborador_id') || '') ? form.get('colaborador_id') : null,
      exige_confirmacao: marcado(form, 'exige_confirmacao'),
      ativo: marcado(form, 'ativo'),
    };
    let erro = null;
    if (!cnpjValido(e.cnpj)) erro = 'CNPJ inválido.';
    else if (!e.razao_social) erro = 'Informe a razão social.';
    else if (!e.nfeio_company_id) erro = 'Informe o ID da empresa na NFE.io.';
    else if (e.municipio_ibge.length !== 7) erro = 'O código IBGE do município tem 7 dígitos.';
    else if (!Number.isInteger(e.valor_min_centavos) || !Number.isInteger(e.valor_max_centavos)) erro = 'Valor mínimo ou máximo inválido.';
    else if (e.valor_max_centavos <= e.valor_min_centavos) erro = 'O valor máximo precisa ser maior que o mínimo.';
    return { e, erro };
  }

  function lerServico(form) {
    const s = {
      apelido: String(form.get('apelido') || '').trim().toLowerCase(),
      descricao_padrao: String(form.get('descricao_padrao') || '').trim(),
      city_service_code: String(form.get('city_service_code') || '').trim(),
      federal_service_code: digitos(form.get('federal_service_code')) || null,
      nbs_code: digitos(form.get('nbs_code')) || null,
      pode_ter_retencao: ['pf', 'pj', 'orgao_publico'].filter((t) => marcado(form, `retencao_${t}`)),
      iss_pode_ser_devido_fora: marcado(form, 'iss_pode_ser_devido_fora'),
      ativo: form.has('_novo') ? true : marcado(form, 'ativo'),
    };
    let erro = null;
    if (!s.apelido || !s.descricao_padrao || !s.city_service_code) erro = 'Informe o apelido, a descrição e o código de serviço municipal.';
    else if (s.federal_service_code && s.federal_service_code.length !== 6) erro = 'O código de tributação nacional tem 6 dígitos.';
    else if (s.nbs_code && s.nbs_code.length !== 9) erro = 'O NBS tem 9 dígitos.';
    return { s, erro };
  }

  async function listaEmpresas(ctx, res, extra = {}) {
    const { rows: empresas } = await db.query(
      `SELECT p.*, (SELECT count(*) FROM prestador_servicos s WHERE s.prestador_id = p.id AND s.ativo)::int AS servicos,
              (SELECT count(*) FROM prestador_remetentes r WHERE r.prestador_id = p.id AND r.ativo)::int AS remetentes
       FROM prestadores p ORDER BY p.razao_social`,
    );
    const { rows: colaboradores } = await db.query('SELECT id, nome, email FROM colaboradores WHERE ativo ORDER BY nome');
    return pagina(res, extra.status || 200, html.paginaEmpresas(ctx, { empresas, colaboradores, nova: extra.nova }));
  }

  async function criarEmpresa(ctx, res, form) {
    const { e, erro } = lerEmpresa(form);
    if (erro) return listaEmpresas({ ...ctx, aviso: { erro: true, texto: erro } }, res, { status: 400, nova: e });
    const { rows: [nova] } = await db.query(
      `INSERT INTO prestadores (cnpj, razao_social, nfeio_company_id, municipio_ibge, valor_min_centavos, valor_max_centavos, exige_confirmacao, ativo, colaborador_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (cnpj) DO NOTHING RETURNING id`,
      [e.cnpj, e.razao_social, e.nfeio_company_id, e.municipio_ibge, e.valor_min_centavos, e.valor_max_centavos, e.exige_confirmacao, e.ativo, e.colaborador_id],
    );
    if (!nova) return listaEmpresas({ ...ctx, aviso: { erro: true, texto: 'Já existe uma empresa com esse CNPJ.' } }, res, { status: 409, nova: e });
    await evento(ctx.colaborador, 'empresa criada', { empresa: e.cnpj, razao_social: e.razao_social });
    return ir(res, `/painel/empresas/${nova.id}?aviso=adicionado`);
  }

  async function verEmpresa(ctx, res, id, extra = {}) {
    const { rows: [empresa] } = await db.query('SELECT * FROM prestadores WHERE id = $1', [id]);
    if (!empresa) return pagina(res, 404, html.paginaErro(ctx, 404, 'Empresa não encontrada'));
    const { rows: colaboradores } = await db.query('SELECT id, nome, email FROM colaboradores WHERE ativo ORDER BY nome');
    const { rows: servicos } = await db.query('SELECT * FROM prestador_servicos WHERE prestador_id = $1 ORDER BY ativo DESC, apelido', [id]);
    const { rows: remetentes } = await db.query('SELECT * FROM prestador_remetentes WHERE prestador_id = $1 ORDER BY ativo DESC, canal, identificador', [id]);
    return pagina(res, extra.status || 200, html.paginaEmpresa(ctx, { empresa: { ...empresa, ...(extra.empresa || {}) }, colaboradores, servicos, remetentes, servicoNovo: extra.servicoNovo }));
  }

  async function salvarEmpresa(ctx, res, id, form) {
    const { e, erro } = lerEmpresa(form);
    if (erro) return verEmpresa({ ...ctx, aviso: { erro: true, texto: erro } }, res, id, { status: 400, empresa: e });
    try {
      const { rowCount } = await db.query(
        `UPDATE prestadores SET cnpj = $2, razao_social = $3, nfeio_company_id = $4, municipio_ibge = $5, valor_min_centavos = $6,
           valor_max_centavos = $7, exige_confirmacao = $8, ativo = $9, colaborador_id = $10 WHERE id = $1`,
        [id, e.cnpj, e.razao_social, e.nfeio_company_id, e.municipio_ibge, e.valor_min_centavos, e.valor_max_centavos, e.exige_confirmacao, e.ativo, e.colaborador_id],
      );
      if (!rowCount) return pagina(res, 404, html.paginaErro(ctx, 404, 'Empresa não encontrada'));
    } catch (err) {
      if (err.code === '23505') return verEmpresa({ ...ctx, aviso: { erro: true, texto: 'Já existe outra empresa com esse CNPJ.' } }, res, id, { status: 409, empresa: e });
      throw err;
    }
    await evento(ctx.colaborador, 'empresa alterada', { empresa: e.cnpj, ...e });
    return ir(res, `/painel/empresas/${id}?aviso=salvo`);
  }

  async function adicionarServico(ctx, res, empresaId, form) {
    form.set('_novo', '1');
    const { s, erro } = lerServico(form);
    if (erro) return verEmpresa({ ...ctx, aviso: { erro: true, texto: erro } }, res, empresaId, { status: 400, servicoNovo: s });
    try {
      await db.query(
        `INSERT INTO prestador_servicos (prestador_id, apelido, descricao_padrao, city_service_code, federal_service_code, nbs_code, pode_ter_retencao, iss_pode_ser_devido_fora)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [empresaId, s.apelido, s.descricao_padrao, s.city_service_code, s.federal_service_code, s.nbs_code, s.pode_ter_retencao, s.iss_pode_ser_devido_fora],
      );
    } catch (err) {
      if (err.code === '23505') return verEmpresa({ ...ctx, aviso: { erro: true, texto: `Esta empresa já tem um serviço "${s.apelido}".` } }, res, empresaId, { status: 409, servicoNovo: s });
      if (err.code === '23503') return pagina(res, 404, html.paginaErro(ctx, 404, 'Empresa não encontrada'));
      throw err;
    }
    await evento(ctx.colaborador, 'serviço criado', { empresa_id: empresaId, ...s });
    return ir(res, `/painel/empresas/${empresaId}?aviso=adicionado`);
  }

  async function salvarServico(ctx, res, id, form) {
    const { rows: [atual] } = await db.query('SELECT prestador_id FROM prestador_servicos WHERE id = $1', [id]);
    if (!atual) return pagina(res, 404, html.paginaErro(ctx, 404, 'Serviço não encontrado'));
    const { s, erro } = lerServico(form);
    if (erro) return verEmpresa({ ...ctx, aviso: { erro: true, texto: erro } }, res, atual.prestador_id, { status: 400 });
    try {
      await db.query(
        `UPDATE prestador_servicos SET apelido = $2, descricao_padrao = $3, city_service_code = $4, federal_service_code = $5, nbs_code = $6,
           pode_ter_retencao = $7, iss_pode_ser_devido_fora = $8, ativo = $9 WHERE id = $1`,
        [id, s.apelido, s.descricao_padrao, s.city_service_code, s.federal_service_code, s.nbs_code, s.pode_ter_retencao, s.iss_pode_ser_devido_fora, s.ativo],
      );
    } catch (err) {
      if (err.code === '23505') return verEmpresa({ ...ctx, aviso: { erro: true, texto: `Esta empresa já tem um serviço "${s.apelido}".` } }, res, atual.prestador_id, { status: 409 });
      throw err;
    }
    await evento(ctx.colaborador, 'serviço alterado', { servico_id: id, ...s });
    return ir(res, `/painel/empresas/${atual.prestador_id}?aviso=salvo`);
  }

  async function adicionarRemetente(ctx, res, empresaId, form) {
    const canal = form.get('canal') === 'whatsapp' ? 'whatsapp' : 'email';
    const bruto = String(form.get('identificador') || '').trim();
    const identificador = canal === 'email' ? bruto.toLowerCase() : telefone(bruto);
    if (canal === 'email' ? !emailValido(identificador) : !identificador) {
      return verEmpresa({ ...ctx, aviso: { erro: true, texto: canal === 'email' ? 'E-mail inválido.' : 'Telefone inválido: use DDD + número.' } }, res, empresaId, { status: 400 });
    }
    const nome = String(form.get('nome') || '').trim() || null;
    try {
      await db.query(
        `INSERT INTO prestador_remetentes (prestador_id, canal, identificador, nome) VALUES ($1, $2, $3, $4)
         ON CONFLICT (prestador_id, canal, identificador) DO UPDATE SET ativo = true, nome = COALESCE(EXCLUDED.nome, prestador_remetentes.nome)`,
        [empresaId, canal, identificador, nome],
      );
    } catch (err) {
      if (err.code === '23503') return pagina(res, 404, html.paginaErro(ctx, 404, 'Empresa não encontrada'));
      throw err;
    }
    await evento(ctx.colaborador, 'remetente adicionado', { empresa_id: empresaId, canal, identificador });
    return ir(res, `/painel/empresas/${empresaId}?aviso=adicionado`);
  }

  async function ativarRemetente(ctx, res, id, form) {
    const ativo = form.get('ativo') === '1';
    const { rows: [r] } = await db.query('UPDATE prestador_remetentes SET ativo = $2 WHERE id = $1 RETURNING prestador_id, canal, identificador', [id, ativo]);
    if (!r) return pagina(res, 404, html.paginaErro(ctx, 404, 'Remetente não encontrado'));
    await evento(ctx.colaborador, ativo ? 'remetente reativado' : 'remetente desativado', { empresa_id: r.prestador_id, canal: r.canal, identificador: r.identificador });
    return ir(res, `/painel/empresas/${r.prestador_id}?aviso=salvo`);
  }

  async function listaColaboradores(ctx, res, extra = {}) {
    const { rows: colaboradores } = await db.query('SELECT id, nome, email, whatsapp, padrao, ativo, senha_hash IS NOT NULL AS tem_senha FROM colaboradores ORDER BY ativo DESC, nome');
    return pagina(res, extra.status || 200, html.paginaColaboradores(ctx, { colaboradores, novo: extra.novo, senhaGerada: extra.senhaGerada }));
  }

  // Só um colaborador padrão: marcar um desmarca os outros (na mesma transação).
  async function gravarColaborador(sql, valores, padrao) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      if (padrao) await c.query('UPDATE colaboradores SET padrao = false WHERE padrao');
      const r = await c.query(sql, valores);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async function criarColaborador(ctx, res, form) {
    const novo = {
      nome: String(form.get('nome') || '').trim(),
      email: String(form.get('email') || '').trim().toLowerCase(),
      whatsapp: String(form.get('whatsapp') || '').trim(),
      padrao: marcado(form, 'padrao'),
    };
    const whatsapp = novo.whatsapp ? telefone(novo.whatsapp) : null;
    let erro = null;
    if (!novo.nome) erro = 'Informe o nome.';
    else if (!emailValido(novo.email)) erro = 'E-mail inválido.';
    else if (novo.whatsapp && !whatsapp) erro = 'WhatsApp inválido: use DDD + número.';
    if (erro) return listaColaboradores({ ...ctx, aviso: { erro: true, texto: erro } }, res, { status: 400, novo });
    try {
      await gravarColaborador('INSERT INTO colaboradores (nome, email, whatsapp, padrao) VALUES ($1, $2, $3, $4)', [novo.nome, novo.email, whatsapp, novo.padrao], novo.padrao);
    } catch (err) {
      if (err.code === '23505') return listaColaboradores({ ...ctx, aviso: { erro: true, texto: 'Já existe um colaborador com esse e-mail.' } }, res, { status: 409, novo });
      throw err;
    }
    await evento(ctx.colaborador, 'colaborador criado', { email: novo.email, padrao: novo.padrao });
    return ir(res, '/painel/colaboradores?aviso=adicionado');
  }

  async function salvarColaborador(ctx, res, id, form) {
    const nome = String(form.get('nome') || '').trim();
    const bruto = String(form.get('whatsapp') || '').trim();
    const whatsapp = bruto ? telefone(bruto) : null;
    if (!nome || (bruto && !whatsapp)) return listaColaboradores({ ...ctx, aviso: { erro: true, texto: !nome ? 'Informe o nome.' : 'WhatsApp inválido: use DDD + número.' } }, res, { status: 400 });
    const padrao = marcado(form, 'padrao');
    const ativo = marcado(form, 'ativo');
    if (id === ctx.colaborador.id && !ativo) return listaColaboradores({ ...ctx, aviso: { erro: true, texto: 'Você não pode desativar o próprio acesso.' } }, res, { status: 400 });
    const { rows: [c] } = await gravarColaborador(
      'UPDATE colaboradores SET nome = $2, whatsapp = $3, padrao = $4, ativo = $5 WHERE id = $1 RETURNING email', [id, nome, whatsapp, padrao, ativo], padrao,
    );
    if (!c) return pagina(res, 404, html.paginaErro(ctx, 404, 'Colaborador não encontrado'));
    if (!ativo) await db.query('DELETE FROM sessoes WHERE colaborador_id = $1', [id]);
    await evento(ctx.colaborador, 'colaborador alterado', { email: c.email, padrao, ativo });
    return ir(res, '/painel/colaboradores?aviso=salvo');
  }

  async function novaSenhaColaborador(ctx, res, id) {
    const senha = gerarSenha();
    const { rows: [c] } = await db.query('UPDATE colaboradores SET senha_hash = $2 WHERE id = $1 RETURNING email', [id, gerarHash(senha)]);
    if (!c) return pagina(res, 404, html.paginaErro(ctx, 404, 'Colaborador não encontrado'));
    if (id !== ctx.colaborador.id) await db.query('DELETE FROM sessoes WHERE colaborador_id = $1', [id]);
    await evento(ctx.colaborador, 'senha gerada', { email: c.email });
    return listaColaboradores(ctx, res, { senhaGerada: { email: c.email, senha } });
  }

  // -------------------------------------------------------------------------
  // Configurações e senha
  // -------------------------------------------------------------------------

  const CONFIG_NUMEROS = { prazo_resposta_dias_uteis: [1, 30], max_rodadas_perguntas: [1, 10], prazo_emissor_horas: [1, 72] };

  async function lerConfig() {
    const { rows } = await db.query('SELECT chave, valor FROM config');
    return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  }

  async function salvarConfiguracoes(ctx, res, form) {
    const novo = {
      emissao_habilitada: marcado(form, 'emissao_habilitada'),
      email_somente_remetentes_cadastrados: marcado(form, 'email_somente_remetentes_cadastrados'),
    };
    for (const [k, [min, max]] of Object.entries(CONFIG_NUMEROS)) {
      const v = Number(form.get(k));
      if (!Number.isInteger(v) || v < min || v > max) {
        return pagina(res, 400, html.paginaConfiguracoes({ ...ctx, aviso: { erro: true, texto: `Valor inválido em "${k}": use um número de ${min} a ${max}.` } }, { cfg: await lerConfig(), instalacao, backup: await situacaoBackup() }));
      }
      novo[k] = v;
    }
    const antes = await lerConfig();
    for (const [k, v] of Object.entries(novo)) {
      await db.query('INSERT INTO config (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor', [k, JSON.stringify(v)]);
    }
    const mudou = Object.fromEntries(Object.entries(novo).filter(([k, v]) => JSON.stringify(antes[k]) !== JSON.stringify(v)).map(([k, v]) => [k, { de: antes[k], para: v }]));
    if (Object.keys(mudou).length) await evento(ctx.colaborador, 'configuração alterada', mudou);
    return ir(res, '/painel/configuracoes?aviso=salvo');
  }

  async function trocarSenha(ctx, res, form) {
    const { rows: [c] } = await db.query('SELECT senha_hash FROM colaboradores WHERE id = $1', [ctx.colaborador.id]);
    const nova = String(form.get('nova') || '');
    let erro = null;
    if (!conferir(String(form.get('atual') || ''), c.senha_hash)) erro = 'A senha atual não confere.';
    else if (nova.length < 10) erro = 'A nova senha precisa ter pelo menos 10 caracteres.';
    else if (nova !== form.get('repetida')) erro = 'As duas novas senhas não são iguais.';
    if (erro) return pagina(res, 400, html.paginaSenha({ ...ctx, aviso: { erro: true, texto: erro } }));
    await db.query('UPDATE colaboradores SET senha_hash = $2 WHERE id = $1', [ctx.colaborador.id, gerarHash(nova)]);
    await db.query('DELETE FROM sessoes WHERE colaborador_id = $1 AND token_hash <> $2', [ctx.colaborador.id, hash(ctx.sessao.token)]);
    await evento(ctx.colaborador, 'senha trocada', {});
    return ir(res, '/painel/pedidos?aviso=senha');
  }

  // -------------------------------------------------------------------------
  // Rotas
  // -------------------------------------------------------------------------

  async function atender(req, res, url, lerCorpo) {
    const caminho = url.pathname.replace(/\/+$/, '') || '/painel';
    const metodo = req.method;
    const form = metodo === 'POST' ? new URLSearchParams(await lerCorpo(req)) : null;

    if (caminho === '/painel/entrar') {
      if (metodo === 'POST') return entrar(req, res, form);
      const { rows: [n] } = await db.query('SELECT count(*)::int AS n FROM colaboradores WHERE senha_hash IS NOT NULL AND ativo');
      return pagina(res, 200, html.paginaLogin({ semSenhas: n.n === 0 }));
    }

    const sessao = await sessaoAtual(req);
    if (!sessao) return metodo === 'GET' ? ir(res, '/painel/entrar') : pagina(res, 401, html.paginaLogin({ erro: 'Sua sessão expirou. Entre de novo.' }));
    const aviso = AVISOS[url.searchParams.get('aviso')];
    const ctx = { colaborador: sessao, sessao, csrf: sessao.csrf, aviso: aviso ? { texto: aviso } : null };

    // Formulários: token CSRF da sessão (o cookie SameSite=Strict já barra outro site; isto é a segunda trava).
    if (metodo === 'POST' && (!form.get('_csrf') || form.get('_csrf') !== sessao.csrf)) {
      return pagina(res, 403, html.paginaErro(ctx, 403, 'Formulário expirado. Volte e tente de novo.'));
    }

    if (caminho === '/painel/sair' && metodo === 'POST') {
      await db.query('DELETE FROM sessoes WHERE token_hash = $1', [hash(sessao.token)]);
      return ir(res, '/painel/entrar', { 'Set-Cookie': cookie('', 0) });
    }
    if (caminho === '/painel') return ir(res, '/painel/pedidos');

    const m = (re) => caminho.match(re);
    let p;
    if (metodo === 'GET') {
      if (caminho === '/painel/pedidos') return listaPedidos(ctx, res, url);
      if ((p = m(/^\/painel\/pedidos\/([0-9a-f-]{36})$/i))) return verPedido(ctx, res, p[1]);
      if ((p = m(/^\/painel\/pedidos\/([0-9a-f-]{36})\/nota\.(pdf|xml)$/i))) return arquivoNota(ctx, res, p[1], p[2].toLowerCase());
      if (caminho === '/painel/empresas') return listaEmpresas(ctx, res);
      if ((p = m(/^\/painel\/empresas\/([0-9a-f-]{36})$/i))) return verEmpresa(ctx, res, p[1]);
      if (caminho === '/painel/colaboradores') return listaColaboradores(ctx, res);
      if (caminho === '/painel/configuracoes') return pagina(res, 200, html.paginaConfiguracoes(ctx, { cfg: await lerConfig(), instalacao, backup: await situacaoBackup() }));
      if (caminho === '/painel/senha') return pagina(res, 200, html.paginaSenha(ctx));
    }
    if (metodo === 'POST') {
      if ((p = m(/^\/painel\/pedidos\/([0-9a-f-]{36})\/resolver$/i))) return resolver(ctx, res, p[1], form);
      if (caminho === '/painel/empresas') return criarEmpresa(ctx, res, form);
      if ((p = m(/^\/painel\/empresas\/([0-9a-f-]{36})$/i))) return salvarEmpresa(ctx, res, p[1], form);
      if ((p = m(/^\/painel\/empresas\/([0-9a-f-]{36})\/servicos$/i))) return adicionarServico(ctx, res, p[1], form);
      if ((p = m(/^\/painel\/empresas\/([0-9a-f-]{36})\/remetentes$/i))) return adicionarRemetente(ctx, res, p[1], form);
      if ((p = m(/^\/painel\/servicos\/([0-9a-f-]{36})$/i))) return salvarServico(ctx, res, p[1], form);
      if ((p = m(/^\/painel\/remetentes\/([0-9a-f-]{36})\/ativo$/i))) return ativarRemetente(ctx, res, p[1], form);
      if (caminho === '/painel/colaboradores') return criarColaborador(ctx, res, form);
      if ((p = m(/^\/painel\/colaboradores\/([0-9a-f-]{36})$/i))) return salvarColaborador(ctx, res, p[1], form);
      if ((p = m(/^\/painel\/colaboradores\/([0-9a-f-]{36})\/senha$/i))) return novaSenhaColaborador(ctx, res, p[1]);
      if (caminho === '/painel/configuracoes') return salvarConfiguracoes(ctx, res, form);
      if (caminho === '/painel/senha') return trocarSenha(ctx, res, form);
    }
    return pagina(res, 404, html.paginaErro(ctx, 404, 'Página não encontrada'));
  }

  return { atender };
}

module.exports = { criarPainel };
