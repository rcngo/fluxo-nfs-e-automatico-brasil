// Executa os cenários de cenarios/*.yaml contra o motor real (motor/app.js), com NFE.io, IA,
// consulta de CNPJ e relógio falsos. Precisa do Postgres do docker compose (porta 5433):
// cria um banco próprio (nfs_cenarios) e o recria a cada execução.
//
// Uso:
//   npm run cenarios                       todos os cenários
//   npm run cenarios -- confirmacao        só os arquivos cujo nome contém "confirmacao"
//   npm run cenario -- cenarios/x.yaml     um arquivo, mostrando a conversa (--verbose)
//
// Formato dos cenários: cenarios/README.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { Pool } = require('pg');
const { migrar } = require('../db/migrar');
const { criarMotor } = require('../motor/app');
const { relogioFalso, nfeioFalsa, brasilapiFalsa, extratorFalso } = require('../motor/falsos');
const { urlBanco } = require('./lib/banco');
const { CAMPOS_PAYLOAD_COMUM } = require('../motor/nfeio');
const { emlParaItem } = require('./lib/eml');
const crypto = require('node:crypto');

// App Secret falso: os cenários assinam o webhook do WhatsApp como a Meta assina.
const SEGREDO_WHATSAPP = 'segredo-de-teste';
const assinarWhatsApp = (corpo) => `sha256=${crypto.createHmac('sha256', SEGREDO_WHATSAPP).update(corpo).digest('hex')}`;

// Webhook da Cloud API com uma mensagem de texto (o mesmo formato de cenarios/whatsapp-payloads/texto.json).
function webhookTexto({ de, texto, id }) {
  const numero = String(de).replace(/\D/g, '');
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
      contacts: [{ profile: { name: 'Cliente' }, wa_id: numero }],
      messages: [{ from: numero, id, timestamp: '1792058400', type: 'text', text: { body: texto } }],
    } }] }],
  };
}

const RAIZ = path.resolve(__dirname, '..');
const PASTA = path.join(RAIZ, 'cenarios');
const BANCO = 'nfs_cenarios';
const PRESTADOR_SEED = '00000000-0000-0000-0000-000000000001';
const REMETENTE_SEED = 'cliente.exemplo@hotmail.com';
const HOJE_PADRAO = '2026-10-15T10:00:00-03:00';

// Receita Federal falsa (CNPJs com dígito verificador válido).
const RECEITA = {
  '75768426000199': { nome: 'AGRO EXEMPLO COMERCIO LTDA', situacao: 'ATIVA', natureza_juridica: '2062', natureza_juridica_descricao: 'Sociedade Empresária Limitada', endereco: { country: 'BRA', postalCode: '80010000', street: 'Rua das Flores', number: '1358', district: 'Centro', city: { code: '4106902', name: 'Curitiba' }, state: 'PR' } },
  '74865958000181': { nome: 'EMPRESA TESTE LTDA', situacao: 'ATIVA', natureza_juridica: '2062', natureza_juridica_descricao: 'Sociedade Empresária Limitada', endereco: { country: 'BRA', postalCode: '01001000', street: 'Praça da Sé', number: '1', district: 'Sé', city: { code: '3550308', name: 'São Paulo' }, state: 'SP' } },
  '74964367000161': { nome: 'EMPRESA BAIXADA LTDA', situacao: 'BAIXADA', natureza_juridica: '2062', natureza_juridica_descricao: 'Sociedade Empresária Limitada', endereco: { country: 'BRA', postalCode: '01001000', street: 'Praça da Sé', number: '2', district: 'Sé', city: { code: '3550308', name: 'São Paulo' }, state: 'SP' } },
  '73479394000186': { nome: 'MUNICIPIO DE EXEMPLO', situacao: 'ATIVA', natureza_juridica: '1244', natureza_juridica_descricao: 'Município', endereco: { country: 'BRA', postalCode: '75701000', street: 'Praça da Prefeitura', number: '1', district: 'Centro', city: { code: '5205109', name: 'Catalão' }, state: 'GO' } },
};

const CAMPOS_EMPRESA = ['exige_confirmacao', 'valor_min_centavos', 'valor_max_centavos', 'ativo', 'colaborador'];
const CAMPOS_SERVICO = ['pode_ter_retencao', 'iss_pode_ser_devido_fora'];

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

// nome: banco próprio de cada suíte (cenários: nfs_cenarios; testes do painel: nfs_painel).
async function prepararBanco(nome = BANCO) {
  const base = urlBanco('postgres', 'DATABASE_URL_TESTE');
  const admin = new Pool({ connectionString: base });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${nome}`);
  } catch (e) {
    throw new Error(`não consegui preparar o banco de cenários (o Postgres do docker compose está rodando?): ${e.message}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${nome}`;
  const pool = new Pool({ connectionString: url.toString() });
  await migrar(pool, { log: () => {} });
  return pool;
}

const SEED = fs.readFileSync(path.join(RAIZ, 'db/seeds/poc.sql'), 'utf8');

async function limparBanco(pool) {
  await pool.query(`TRUNCATE encaminhamentos, eventos, mensagens, pedidos, tomadores, prestador_servicos, prestador_remetentes, prestadores, colaboradores, config RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO config VALUES ('emissao_habilitada', 'true'), ('prazo_resposta_dias_uteis', '2'), ('max_rodadas_perguntas', '2'), ('prazo_emissor_horas', '4'), ('email_somente_remetentes_cadastrados', 'true')`);
  await pool.query(SEED);
}

// ---------------------------------------------------------------------------
// Execução de um cenário
// ---------------------------------------------------------------------------

function duracaoMs(s) {
  const m = String(s).match(/^(\d+)\s*([dhm])$/);
  if (!m) throw new Error(`duração inválida "${s}" (use 3d, 2h, 30m)`);
  return Number(m[1]) * { d: 86400000, h: 3600000, m: 60000 }[m[2]];
}

const lista = (v) => (Array.isArray(v) ? v : [v]);

async function aplicarDado(pool, dado, inicio) {
  for (const col of dado.colaboradores || []) {
    if (col.padrao) await pool.query('UPDATE colaboradores SET padrao = false');
    await pool.query('INSERT INTO colaboradores (nome, email, whatsapp, padrao) VALUES ($1, $2, $3, $4)', [col.nome, col.email, col.whatsapp || null, Boolean(col.padrao)]);
  }
  if (dado.sem_colaboradores) await pool.query('DELETE FROM colaboradores');
  if (dado.empresa) {
    for (const [k, v] of Object.entries(dado.empresa)) {
      if (!CAMPOS_EMPRESA.includes(k)) throw new Error(`dado.empresa.${k} não suportado (use ${CAMPOS_EMPRESA.join(', ')})`);
      if (k === 'colaborador') {
        await pool.query('UPDATE prestadores SET colaborador_id = (SELECT id FROM colaboradores WHERE email = $2) WHERE id = $1', [PRESTADOR_SEED, v]);
      } else {
        await pool.query(`UPDATE prestadores SET ${k} = $2 WHERE id = $1`, [PRESTADOR_SEED, v]);
      }
    }
  }
  // Serviço da empresa de teste ("programação").
  for (const [k, v] of Object.entries(dado.servico || {})) {
    if (!CAMPOS_SERVICO.includes(k)) throw new Error(`dado.servico.${k} não suportado (use ${CAMPOS_SERVICO.join(', ')})`);
    await pool.query(`UPDATE prestador_servicos SET ${k} = $2 WHERE prestador_id = $1`, [PRESTADOR_SEED, v]);
  }
  for (const [k, v] of Object.entries(dado.config || {})) {
    await pool.query('UPDATE config SET valor = $2 WHERE chave = $1', [k, JSON.stringify(v)]);
  }
  // Remetentes a mais para a empresa de teste (ex.: o WhatsApp do cliente).
  for (const r of dado.remetentes || []) {
    await pool.query(`INSERT INTO prestador_remetentes (prestador_id, canal, identificador) VALUES ($1, $2, $3)`, [PRESTADOR_SEED, r.canal, r.identificador]);
  }
  // Outras empresas que o mesmo remetente (seed) pode representar.
  for (const e of dado.outras_empresas || []) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO prestadores (cnpj, razao_social, nfeio_company_id, municipio_ibge, valor_min_centavos, valor_max_centavos, exige_confirmacao)
       VALUES ($1, $2, $3, '5205109', 10000, 5000000, $4) RETURNING id`,
      [String(e.cnpj), e.razao_social, `empresa-falsa-${e.cnpj}`, e.exige_confirmacao ?? true],
    );
    await pool.query(`INSERT INTO prestador_remetentes (prestador_id, canal, identificador) VALUES ($1, 'email', $2)`, [p.id, REMETENTE_SEED]);
    await pool.query(
      `INSERT INTO prestador_servicos (prestador_id, apelido, descricao_padrao, city_service_code, federal_service_code, nbs_code)
       VALUES ($1, $2, $3, '010201', '010201', '115021000')`,
      [p.id, e.servico || 'programação', e.descricao_servico || 'Serviço de Programador'],
    );
  }
  // Tomadores cadastrados para a empresa de teste: como vindos da planilha (sem endereço) ou,
  // com `consultado_antes_da_e3`, já consultados na Receita mas sem a natureza jurídica.
  for (const t of dado.tomadores || []) {
    const receita = t.consultado_antes_da_e3 ? RECEITA[String(t.documento)] : null;
    await pool.query(
      `INSERT INTO tomadores (prestador_id, documento, nome, email, endereco, situacao_cadastral) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (prestador_id, documento) DO UPDATE
         SET nome = EXCLUDED.nome, endereco = EXCLUDED.endereco, situacao_cadastral = EXCLUDED.situacao_cadastral, natureza_juridica = NULL`,
      [PRESTADOR_SEED, String(t.documento), t.nome, t.email || null, receita && receita.endereco, receita && receita.situacao],
    );
  }
  if (dado.emissao_habilitada !== undefined) {
    await pool.query(`UPDATE config SET valor = $1 WHERE chave = 'emissao_habilitada'`, [JSON.stringify(Boolean(dado.emissao_habilitada))]);
  }
  for (const [i, h] of (dado.historico || []).entries()) {
    const criado = new Date(inicio.getTime() - duracaoMs(h.ha || '1h'));
    await pool.query(
      `INSERT INTO pedidos (canal, remetente, conversa_ref, prestador_id, estado, valor_centavos, tomador_documento, criado_em, atualizado_em)
       VALUES ('email', $1, $2, $3, $4, $5, $6, $7, $7)`,
      [REMETENTE_SEED, `historico-${i}`, PRESTADOR_SEED, h.estado || 'ENTREGUE', h.valor, String(h.tomador), criado],
    );
  }
}

async function rodarCenario(pool, arquivo) {
  const cenario = YAML.parse(fs.readFileSync(arquivo, 'utf8'));
  const dado = cenario.dado || {};
  const hoje = dado.hoje ? (String(dado.hoje).length === 10 ? `${dado.hoje}T10:00:00-03:00` : dado.hoje) : HOJE_PADRAO;
  const inicio = new Date(hoje);

  await limparBanco(pool);
  await aplicarDado(pool, dado, inicio);

  const relogio = relogioFalso(inicio);
  const nfeio = nfeioFalsa(dado.nfeio || 'sucesso', { consulta: dado.nfeio_consulta });
  const extrator = extratorFalso();
  const motor = criarMotor({
    db: pool,
    extrator,
    nfeio,
    // receita: fora → a consulta de CNPJ não responde (BrasilAPI fora do ar ou bloqueada).
    consultarCnpj: dado.receita === 'fora' ? async () => null : brasilapiFalsa(RECEITA),
    relogio,
    pastaDominio: fs.mkdtempSync(path.join(os.tmpdir(), 'nfs-cenario-')),
    esperar: async () => {},
    urlPublica: 'http://motor.teste',
    whatsapp: { appSecret: SEGREDO_WHATSAPP, verifyToken: 'token-de-teste' },
  });

  const conversa = []; // para mostrar em caso de falha (ou com --verbose)
  let ultimo = [];
  let ultimoLink = null;
  let n = 0;
  const registrar = (resultados) => {
    ultimo = resultados;
    for (const r of resultados) {
      if (r.encaminhar) conversa.push(`  → encaminhado a ${r.encaminhar.para_email || '(ninguém: sem colaborador)'}: ${r.encaminhar.assunto}`);
      if (r.responder) conversa.push(`  sistema: ${r.texto.replace(/\n/g, '\n           ')}${r.anexos && r.anexos.length ? `\n           [anexos: ${r.anexos.map((a) => a.nome).join(', ')}]` : ''}`);
      else if (!r.encaminhar) conversa.push(`  (sistema não responde${r.motivo ? `: ${r.motivo}` : ''})`);
      else conversa.push('  (sem resposta ao cliente)');
    }
  };
  // Pedido da conversa indicada; sem indicação, o da conversa padrão do e-mail ou, se não houver
  // (WhatsApp: a conversa é o número), o mais recente.
  const pedidoAtual = async (conv) => {
    const { rows: [p] } = await pool.query(`SELECT * FROM pedidos WHERE conversa_ref = $1 ORDER BY criado_em DESC LIMIT 1`, [conv || 'conversa-1']);
    if (p || conv) return p;
    return (await pool.query('SELECT * FROM pedidos ORDER BY criado_em DESC LIMIT 1')).rows[0];
  };

  const verificacoes = {
    async cliente(v) {
      const p = typeof v === 'string' ? { texto: v } : v;
      n++;
      extrator.sobrescrever(p.ia);
      if (p.whatsapp || p.canal === 'whatsapp') {
        // Mesmo caminho do workflow "NFS - WhatsApp": webhook assinado → /whatsapp/webhook → /processar.
        const payload = p.whatsapp
          ? JSON.parse(fs.readFileSync(path.join(PASTA, 'whatsapp-payloads', p.whatsapp), 'utf8'))
          : webhookTexto({ de: p.de || '+5564999990000', texto: p.texto, id: p.id || `wamid.teste-${n}` });
        const corpo = JSON.stringify(payload);
        const assinatura = p.assinatura === 'invalida' ? `sha256=${'0'.repeat(64)}` : assinarWhatsApp(corpo);
        const r = await motor.receberWhatsApp({ corpo, assinatura });
        conversa.push(`  cliente (WhatsApp${p.whatsapp ? `, ${p.whatsapp}` : ''}): ${r.mensagens.map((m) => m.texto).join(' | ') || '(sem mensagem de conversa)'}`);
        if (!r.valido) {
          conversa.push('  (webhook recusado: assinatura inválida)');
          ultimo = [{ responder: false, recusado: true }];
        } else {
          const respostas = [];
          for (const m of r.mensagens) respostas.push(await motor.processar(m));
          registrar(respostas);
        }
        relogio.avancar(60000);
        return;
      }
      if (p.eml) {
        // E-mail de verdade (cenarios/emails/): mesmo caminho do workflow do n8n (POST /email).
        const item = await emlParaItem(fs.readFileSync(path.join(PASTA, 'emails', p.eml)), { id: `gmail-${n}`, threadId: p.conversa || 'conversa-1' });
        conversa.push(`  cliente (${p.eml}): ${String(item.text || '').trim().replace(/\n/g, '\n           ')}`);
        registrar([await motor.processarEmail(item)]);
        relogio.avancar(60000);
        return;
      }
      conversa.push(`  cliente: ${p.texto}`);
      const de = p.de || REMETENTE_SEED;
      const dominio = de.split('@')[1];
      const r = await motor.processar({
        canal: p.canal || 'email',
        remetente: de,
        conversa_ref: p.conversa || 'conversa-1',
        message_id: p.id || `msg-${n}`,
        gmail_id: `gmail-${n}`,
        texto: p.texto,
        auth_results: p.autenticado === false
          ? `mx.google.com; dkim=fail header.i=@${dominio}; spf=fail; dmarc=fail header.from=${dominio}`
          : `mx.google.com; dkim=pass header.i=@${dominio}; spf=pass smtp.mailfrom=${de}; dmarc=pass (p=NONE) header.from=${dominio}`,
      });
      registrar([r]);
      relogio.avancar(60000); // um minuto entre mensagens
    },
    async sistema_responde_contendo(v) {
      // toLocaleString('pt-BR') separa "R$" do número com espaço não separável.
      const normal = (s) => String(s).replace(/[  ]/g, ' ').toLowerCase();
      const respostas = ultimo.filter((r) => r.responder).map((r) => normal(r.texto));
      if (!respostas.length) return 'o sistema não respondeu';
      for (const trecho of lista(v)) {
        if (!respostas.some((t) => t.includes(normal(trecho)))) {
          return `nenhuma resposta contém "${trecho}"`;
        }
      }
    },
    async sistema_nao_responde() {
      const r = ultimo.find((x) => x.responder);
      if (r) return `o sistema respondeu: "${r.texto}"`;
    },
    async estado(v, conv) {
      const p = await pedidoAtual(conv);
      if (!p) return 'nenhum pedido encontrado';
      if (p.estado !== v) return `estado ${p.estado}${p.motivo ? ` (motivo: ${p.motivo})` : ''}, esperado ${v}`;
    },
    async motivo_contendo(v) {
      const p = await pedidoAtual();
      if (!p || !String(p.motivo || '').toLowerCase().includes(String(v).toLowerCase())) return `motivo "${p && p.motivo}", esperado conter "${v}"`;
    },
    // Texto gravado da última mensagem do cliente (depois de tirar o histórico citado).
    async mensagem_do_cliente_registrada(v) {
      const { rows: [m] } = await pool.query(`SELECT conteudo FROM mensagens WHERE direcao = 'entrada' ORDER BY criado_em DESC LIMIT 1`);
      if (!m) return 'nenhuma mensagem do cliente gravada';
      if (m.conteudo !== v) return `mensagem gravada: ${JSON.stringify(m.conteudo)}, esperado ${JSON.stringify(v)}`;
    },
    // Resposta pelo WhatsApp: { para: número, modelo: false | nome do modelo (fora da janela de 24 h) }.
    async resposta_whatsapp(v) {
      const r = ultimo.find((x) => x.responder);
      if (!r) return 'o sistema não respondeu';
      if (r.canal !== 'whatsapp') return `resposta pelo canal ${r.canal}`;
      if (v.para !== undefined && r.responder_para !== v.para) return `resposta para ${r.responder_para}, esperado ${v.para}`;
      if (v.modelo === false && r.modelo) return `resposta por modelo (${r.modelo.nome}), esperado texto livre dentro da janela`;
      if (typeof v.modelo === 'string' && (!r.modelo || r.modelo.nome !== v.modelo)) return `resposta ${r.modelo ? `pelo modelo ${r.modelo.nome}` : 'em texto livre'}, esperado modelo ${v.modelo}`;
    },
    async webhook_recusado() {
      if (!ultimo.some((r) => r.recusado)) return 'o webhook foi aceito';
    },
    // Evento sem pedido (ex.: falha de envio avisada pela Meta): { tipo, contendo }.
    async evento_registrado(v) {
      const { rows } = await pool.query('SELECT detalhe::text AS d FROM eventos WHERE tipo = $1', [v.tipo]);
      if (!rows.some((r) => r.d.includes(v.contendo))) return `nenhum evento "${v.tipo}" contendo "${v.contendo}"`;
    },
    async nenhum_pedido() {
      const { rows: [r] } = await pool.query('SELECT (SELECT count(*) FROM pedidos)::int AS p, (SELECT count(*) FROM mensagens)::int AS m');
      if (r.p || r.m) return `${r.p} pedido(s) e ${r.m} mensagem(ns) gravados, esperado nada`;
    },
    async notas_emitidas(v) {
      if (nfeio.emissoes.length !== v) return `${nfeio.emissoes.length} nota(s) emitida(s), esperado ${v}`;
    },
    async nota_emitida(v) {
      const e = nfeio.emissoes[nfeio.emissoes.length - 1];
      if (!e) return 'nenhuma nota foi emitida';
      const valor = Math.round(e.payload.servicesAmount * 100);
      if (v.valor !== undefined && valor !== v.valor) return `valor emitido ${valor}, esperado ${v.valor}`;
      if (v.tomador !== undefined && String(e.payload.borrower.federalTaxNumber) !== String(Number(v.tomador))) {
        return `tomador emitido ${e.payload.borrower.federalTaxNumber}, esperado ${v.tomador}`;
      }
      if (v.competencia !== undefined && e.payload.accrualOn !== `${v.competencia}-01`) {
        return `competência enviada ${e.payload.accrualOn}, esperado ${v.competencia}-01`;
      }
      if (v.empresa !== undefined) {
        const { rows: [p] } = await pool.query('SELECT cnpj FROM prestadores WHERE nfeio_company_id = $1', [e.companyId]);
        if (!p || p.cnpj !== String(v.empresa)) return `nota emitida pela empresa ${p ? p.cnpj : e.companyId}, esperado ${v.empresa}`;
      }
    },
    // O que foi à NFE.io só tem os campos do caso comum: nenhum campo de imposto.
    async payload_sem_impostos() {
      const e = nfeio.emissoes[nfeio.emissoes.length - 1];
      if (!e) return 'nenhuma nota foi emitida';
      const extras = Object.keys(e.payload).filter((k) => !CAMPOS_PAYLOAD_COMUM.includes(k));
      if (extras.length) return `o payload enviado à NFE.io tem campos além do caso comum: ${extras.join(', ')}`;
    },
    async sistema_entrega(v) {
      const anexos = ultimo.flatMap((r) => r.anexos || []).map((a) => a.campo.replace('nota_', ''));
      for (const tipo of lista(v)) if (!anexos.includes(tipo)) return `entrega sem ${tipo} (anexos: ${anexos.join(', ') || 'nenhum'})`;
    },
    async passa_tempo(v) {
      relogio.avancar(duracaoMs(v));
      conversa.push(`  … passam ${v} (tarefas periódicas rodam)`);
      // Como no n8n: cada workflow chama /retomar para o seu canal e envia pelo seu canal.
      const respostas = [];
      for (const canal of ['email', 'whatsapp']) {
        for (const r of await motor.retomar({ canal })) {
          if (r.canal && r.canal !== canal) return `a tarefa periódica do canal ${canal} devolveu resposta do canal ${r.canal}`;
          respostas.push(r);
        }
      }
      registrar(respostas);
    },
    // Mensagem ao colaborador: { motivo, para, contendo: [trechos] }
    async encaminhado_ao_colaborador(v) {
      const e = ultimo.map((r) => r.encaminhar).find(Boolean);
      if (!e) return 'nada foi encaminhado ao colaborador';
      if (v.motivo && e.motivo !== v.motivo) return `motivo ${e.motivo}, esperado ${v.motivo}`;
      if (v.para !== undefined && e.para_email !== v.para) return `encaminhado a ${e.para_email}, esperado ${v.para}`;
      if (v.midia !== undefined && (!e.midia || e.midia.id !== v.midia)) return `arquivo para anexar ${e.midia ? e.midia.id : '(nenhum)'}, esperado ${v.midia}`;
      const texto = `${e.assunto}\n${e.texto}`.replace(/[\u00a0\u202f]/g, ' ').toLowerCase();
      for (const trecho of lista(v.contendo || [])) {
        if (!texto.includes(String(trecho).toLowerCase())) return `a mensagem ao colaborador não contém "${trecho}"\n${e.assunto}\n${e.texto}`;
      }
      ultimoLink = e.link;
    },
    async nada_encaminhado() {
      const e = ultimo.map((r) => r.encaminhar).find(Boolean);
      if (e) return `foi encaminhado ao colaborador (${e.motivo})`;
    },
    // O colaborador abre o link do último encaminhamento e clica em "Marcar como resolvido".
    // Valor: true, { numero_nota }, ou { link: 'adulterado' } / { esperado: 'ja_resolvido' }.
    async colaborador_resolve(v) {
      const opc = typeof v === 'object' ? v : {};
      const e = ultimo.map((r) => r.encaminhar).find(Boolean);
      const link = (e && e.link) || ultimoLink;
      if (!link) return 'não há link de encaminhamento';
      let token = new URL(link).searchParams.get('t');
      if (opc.link === 'adulterado') token = `${token.slice(0, -2)}xx`;
      const pagina = await motor.consultarEncaminhamento(token);
      const r = await motor.resolverEncaminhamento(token, { numero_nota: opc.numero_nota });
      const esperado = opc.esperado || (opc.link === 'adulterado' ? 'invalido' : 'resolvido');
      conversa.push(`  (colaborador abre o link: página "${pagina.status}"; clica em resolvido: ${r.status})`);
      if (r.status !== esperado) return `resultado ${r.status}, esperado ${esperado}`;
      ultimoLink = link;
    },
    // O escritório muda a configuração no meio do cenário (ex.: desliga a emissão).
    async escritorio_configura(v) {
      for (const [k, valor] of Object.entries(v)) await pool.query('UPDATE config SET valor = $2 WHERE chave = $1', [k, JSON.stringify(valor)]);
      conversa.push(`  (escritório configura: ${JSON.stringify(v)})`);
    },
    async nfeio_conclui() {
      nfeio.concluirPendentes();
    },
    // O n8n enviou a nota ao cliente e avisa o motor (POST /entregue).
    async canal_confirma_entrega() {
      const r = ultimo.find((x) => x.pedido_id && x.anexos && x.anexos.length);
      if (!r) return 'não há entrega de nota para confirmar';
      const { ok } = await motor.entregue({ pedido_id: r.pedido_id });
      if (!ok) return 'o motor não aceitou a confirmação de entrega';
    },
  };

  for (const [i, passo] of (cenario.passos || []).entries()) {
    const [tipo, valor] = Object.entries(passo)[0];
    const fn = verificacoes[tipo];
    if (!fn) return { cenario, conversa, falha: `passo ${i + 1}: tipo "${tipo}" desconhecido` };
    const erro = await fn(valor, passo.conversa);
    if (erro) return { cenario, conversa, falha: `passo ${i + 1} (${tipo}): ${erro}` };
  }
  // Em nenhum cenário a NFE.io pode receber mais de uma nota do mesmo pedido.
  const porPedido = {};
  for (const e of nfeio.emissoes) {
    if (!e.payload.externalId) return { cenario, conversa, falha: 'nota enviada à NFE.io sem a referência do pedido (externalId)' };
    porPedido[e.payload.externalId] = (porPedido[e.payload.externalId] || 0) + 1;
  }
  const duplicado = Object.entries(porPedido).find(([, n]) => n > 1);
  if (duplicado) return { cenario, conversa, falha: `o pedido ${duplicado[0]} foi enviado ${duplicado[1]} vezes à NFE.io` };
  return { cenario, conversa };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function listarArquivos(filtro) {
  if (filtro && filtro.endsWith('.yaml')) return [path.resolve(filtro)];
  const todos = [];
  const andar = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) andar(p);
      else if (f.name.endsWith('.yaml')) todos.push(p);
    }
  };
  andar(PASTA);
  // O filtro vale para o caminho dentro de cenarios/ (ex.: "tributario" pega a pasta inteira).
  return todos.sort().filter((p) => !filtro || path.relative(PASTA, p).includes(filtro));
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const filtro = args.find((a) => !a.startsWith('--'));
  const arquivos = listarArquivos(filtro);
  if (!arquivos.length) throw new Error(`nenhum cenário encontrado${filtro ? ` para "${filtro}"` : ''}`);

  const pool = await prepararBanco();
  let ok = 0;
  let falhas = 0;
  let pendentes = 0;
  try {
    for (const arquivo of arquivos) {
      const nomeArquivo = path.relative(RAIZ, arquivo);
      let bruto;
      try {
        bruto = YAML.parse(fs.readFileSync(arquivo, 'utf8'));
      } catch (e) {
        falhas++;
        console.log(`✖ YAML inválido  (${nomeArquivo})\n  → ${e.message.split('\n')[0]}\n`);
        continue;
      }
      if (bruto.pendente) {
        pendentes++;
        console.log(`○ ${bruto.nome}  (${nomeArquivo}) — pendente: ${bruto.pendente}`);
        continue;
      }
      let r;
      try {
        r = await rodarCenario(pool, arquivo);
      } catch (e) {
        r = { cenario: bruto, conversa: [], falha: `erro ao executar: ${e.stack || e.message}` };
      }
      // Autoteste do executor: cenários com deve_falhar precisam falhar.
      const passou = bruto.deve_falhar ? Boolean(r.falha) : !r.falha;
      const rotulo = bruto.deve_falhar ? ' [autoteste: deve falhar]' : '';
      console.log(`${passou ? '✔' : '✖'} ${bruto.nome}${rotulo}  (${nomeArquivo})`);
      if (!passou || verbose) {
        if (r.conversa.length) console.log(r.conversa.join('\n'));
        if (r.falha) console.log(`  → ${r.falha}`);
        else if (bruto.deve_falhar) console.log('  → o cenário deveria ter falhado e passou');
        console.log('');
      }
      passou ? ok++ : falhas++;
    }
  } finally {
    await pool.end();
  }
  console.log(`\n${ok} ok · ${falhas} falha(s)${pendentes ? ` · ${pendentes} pendente(s)` : ''}`);
  process.exit(falhas ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { rodarCenario, prepararBanco };
