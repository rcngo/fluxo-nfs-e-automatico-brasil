// Avaliação com o Claude real: extração (Claude) + escolha da empresa e decisão (código) em todos
// os casos, sem emitir nada. Mede acerto da ação, por campo, emissões indevidas, encaminhamentos
// e perguntas desnecessárias e o custo; salva o relatório em avaliacao/relatorios/.
//
// Uso:
//   set -a && . infra/secrets.env && set +a
//   npm run avaliar                                     todos os casos, modelo padrão (n8n/extrair.js)
//   npm run avaliar -- --modelos claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5
//   npm run avaliar -- --casos avaliacao/casos/adversariais.json --effort medium
//
// Casos: avaliacao/casos/*.json e avaliacao/casos/reais/*.json (reais ficam fora do git).
// Formato em avaliacao/README.md. Saída com código 2 se houver emissão indevida.

const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const { extrair, MODELO, VERSAO_PROMPT } = require('../n8n/extrair');
const { decidir } = require('../n8n/decidir');
const { escolherEmpresa } = require('../motor/empresa');
const { PRECOS } = require('./precos');

const PASTA_CASOS = path.join(__dirname, 'casos');
const PASTA_RELATORIOS = path.join(__dirname, 'relatorios');

// Mesmo cadastro de db/seeds/poc.sql (e a Aurora dos cenários de duas empresas).
// exige_confirmacao=false para medir a decisão final.
const PRESTADORES = {
  modelo: { id: 'p-modelo', ativo: true, razao_social: 'MODELO E CIA DESENVOLVIMENTO DE SISTEMAS LTDA', cnpj: '82571297000100', valor_min_centavos: 10000, valor_max_centavos: 5000000, exige_confirmacao: false },
  aurora: { id: 'p-aurora', ativo: true, razao_social: 'AURORA SERVICOS DIGITAIS LTDA', cnpj: '81452590000195', valor_min_centavos: 10000, valor_max_centavos: 5000000, exige_confirmacao: false },
};
const SERVICO = { id: 'srv-prog', apelido: 'programação', descricao_padrao: 'Serviço de Programador', city_service_code: '010201', pode_ter_retencao: [], iss_pode_ser_devido_fora: false };
// Simula o cadastro/BrasilAPI.
const RECEITA = {
  '75768426000199': { nome: 'AGRO EXEMPLO COMERCIO LTDA', situacao: 'ATIVA', natureza_juridica: '2062', endereco: { city: { code: '4106902' } } },
  '74865958000181': { nome: 'EMPRESA TESTE LTDA', situacao: 'ATIVA', natureza_juridica: '2062', endereco: { city: { code: '3550308' } } },
};
const CAMPOS = ['tomador_documento', 'valor_centavos', 'competencia', 'motivo', 'empresa'];

function lerArgs() {
  const a = process.argv.slice(2);
  const valor = (nome) => { const i = a.indexOf(`--${nome}`); return i >= 0 ? a[i + 1] : null; };
  return {
    modelos: (valor('modelos') || MODELO).split(',').map((m) => m.trim()).filter(Boolean),
    effort: valor('effort') || 'low',
    casos: valor('casos'),
  };
}

function carregarCasos(arquivo) {
  const arquivos = arquivo ? [path.resolve(arquivo)] : [
    ...fs.readdirSync(PASTA_CASOS).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(PASTA_CASOS, f)),
    ...(fs.existsSync(path.join(PASTA_CASOS, 'reais')) ? fs.readdirSync(path.join(PASTA_CASOS, 'reais')).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(PASTA_CASOS, 'reais', f)) : []),
  ];
  return arquivos.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).map((c) => ({ ...c, origem: path.relative(__dirname, f) })));
}

async function rodarCaso(client, caso, { modelo, effort }) {
  const hoje = caso.mensagens[caso.mensagens.length - 1].data.slice(0, 10);
  const candidatos = (caso.prestadores || ['modelo']).map((k) => PRESTADORES[k]);
  // Várias empresas: a escolha é em código (motor/empresa.js), antes da IA.
  const escolha = candidatos.length === 1 ? { prestador: candidatos[0] } : escolherEmpresa(candidatos, caso.mensagens);
  if (!escolha) return { caso, decisao: { acao: 'perguntar_empresa' }, usage: null, ms: 0 };
  const prestador = escolha.prestador;
  const servicos = [{ ...SERVICO, ...(caso.servicos || {}) }];
  const inicio = Date.now();
  const r = await extrair(client, { hoje, canal: 'email', prestador, servicos, mensagens: caso.mensagens }, { modelo, effort });
  const ms = Date.now() - inicio;
  if (!r.ok) return { caso, erro: r.motivo, ms, decisao: { acao: 'encaminhar', motivo: 'falha_leitura' } };
  const x = r.extracao;
  const doc = (x.tomador_documento.valor || '').replace(/\D/g, '');
  const consulta = RECEITA[doc] ? { ...RECEITA[doc], ...((caso.receita || {})[doc] || {}) } : null;
  // Como o motor: informação nova durante a confirmação recalcula em vez de emitir o resumo antigo.
  const estado = caso.estado_atual || 'RECEBIDO';
  const corrigindo = estado === 'AGUARDANDO_CONFIRMACAO' && !x.resposta_confirmacao && ['complemento', 'pedido_nota'].includes(x.intencao);
  const decisao = decidir({
    extracao: x, estado_atual: corrigindo ? 'AGUARDANDO_CLIENTE' : estado, remetente_autenticado: true, prestador, servicos,
    tomador_consulta: consulta, duplicados_24h: 0, emissao_habilitada: true, hoje,
    // Na confirmação o resumo pede SIM: sem corrigir, "confirmar" de novo = resumo novo.
    ...(estado === 'AGUARDANDO_CONFIRMACAO' ? { prestador: { ...prestador, exige_confirmacao: true } } : {}),
  });
  if (decisao.acao === 'emitir' && !decisao.dados && estado === 'AGUARDANDO_CONFIRMACAO') decisao.emitiu_resumo_antigo = true;
  return { caso, r, decisao, empresa: prestador.cnpj, usage: r.usage, modelo_resposta: r.modelo, ms };
}

function comparar({ caso, decisao, empresa }) {
  const esp = caso.esperado;
  const erros = [];
  const aceitas = esp.aceitas || [esp.acao];
  if (!aceitas.includes(decisao.acao)) erros.push(`ação ${decisao.acao} ≠ ${aceitas.join('|')}`);
  if (esp.motivo && decisao.acao === 'encaminhar' && decisao.motivo !== esp.motivo) erros.push(`motivo ${decisao.motivo} ≠ ${esp.motivo}`);
  if (esp.faltantes && decisao.acao === 'perguntar') {
    const falt = (decisao.faltantes || []).slice().sort().join(',');
    if (falt !== esp.faltantes.slice().sort().join(',')) erros.push(`faltantes [${falt}] ≠ [${esp.faltantes}]`);
  }
  const campos = {};
  if (decisao.dados && ['emitir', 'confirmar'].includes(decisao.acao)) {
    const obtido = { tomador_documento: decisao.dados.tomador.documento, valor_centavos: decisao.dados.valor_centavos, competencia: decisao.dados.competencia, empresa };
    for (const c of ['tomador_documento', 'valor_centavos', 'competencia', 'empresa']) {
      if (esp[c] === undefined) continue;
      campos[c] = esp[c] === obtido[c];
      if (!campos[c]) erros.push(`${c} ${obtido[c]} ≠ ${esp[c]}`);
    }
  }
  if (esp.motivo) campos.motivo = decisao.motivo === esp.motivo;
  return { erros, campos };
}

function custo(modelo, usage) {
  const p = PRECOS[modelo];
  if (!p || !usage) return null;
  return (
    (usage.input_tokens || 0) * p.entrada +
    (usage.cache_creation_input_tokens || 0) * p.entrada * 1.25 +
    (usage.cache_read_input_tokens || 0) * p.cache_leitura +
    (usage.output_tokens || 0) * p.saida
  ) / 1e6;
}

async function avaliarModelo(client, casos, { modelo, effort }) {
  // Poucos em paralelo, para não estourar o limite de requisições.
  const resultados = [];
  for (let i = 0; i < casos.length; i += 5) {
    resultados.push(...await Promise.all(casos.slice(i, i + 5).map((c) => rodarCaso(client, c, { modelo, effort }).catch((e) => ({ caso: c, erro: e.message, decisao: { acao: 'erro' } })))));
  }
  const m = { modelo, effort, casos: casos.length, ok: 0, indevidas: 0, encaminhamentos_desnecessarios: 0, perguntas_desnecessarias: 0, falhas: 0, custo: 0, ms: [], campos: {}, linhas: [] };
  for (const res of resultados) {
    const { erros, campos } = res.erro && res.decisao.acao === 'erro' ? { erros: [`erro: ${res.erro}`], campos: {} } : comparar(res);
    const esp = res.caso.esperado;
    const obtida = res.decisao.acao;
    const aceitas = esp.aceitas || [esp.acao];
    if (res.erro) m.falhas++;
    // Emissão indevida: emitiu quando não devia, ou emitiu com algum campo errado.
    const indevida = obtida === 'emitir' && (!aceitas.includes('emitir') || Object.values(campos).includes(false) || res.decisao.emitiu_resumo_antigo);
    if (indevida) m.indevidas++;
    if (obtida === 'encaminhar' && !aceitas.includes('encaminhar')) m.encaminhamentos_desnecessarios++;
    if (obtida === 'perguntar' && esp.acao === 'emitir') m.perguntas_desnecessarias++;
    for (const [c, certo] of Object.entries(campos)) {
      m.campos[c] = m.campos[c] || { certos: 0, total: 0 };
      m.campos[c].total++;
      if (certo) m.campos[c].certos++;
    }
    const valor = custo(modelo, res.usage);
    if (valor) m.custo += valor;
    if (res.ms) m.ms.push(res.ms);
    if (!erros.length) m.ok++;
    m.linhas.push({ id: res.caso.id, origem: res.caso.origem, esperado: aceitas.join('|'), obtido: `${obtida}${res.decisao.motivo && obtida === 'encaminhar' ? ` (${res.decisao.motivo})` : ''}`, indevida, erros, modelo_resposta: res.modelo_resposta, usage: res.usage });
  }
  m.ms.sort((a, b) => a - b);
  m.latencia_mediana = m.ms.length ? m.ms[Math.floor(m.ms.length / 2)] : null;
  delete m.ms;
  return m;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const dolar = (v) => `US$ ${v.toFixed(4)}`;

function relatorioMarkdown(resultados, { quando, casos }) {
  const l = [`# Avaliação da extração — ${quando}`, '', `Prompt \`${VERSAO_PROMPT}\` · ${casos.length} casos (${[...new Set(casos.map((c) => c.origem))].join(', ')})`, ''];
  l.push('| Modelo | Effort | Acerto | Emissões indevidas | Encaminhamentos a mais | Perguntas a mais | Falhas | Custo total | Custo por caso | Latência mediana |');
  l.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const m of resultados) {
    l.push(`| \`${m.modelo}\` | ${m.effort} | ${m.ok}/${m.casos} (${pct(m.ok, m.casos)}) | **${m.indevidas}** | ${m.encaminhamentos_desnecessarios} | ${m.perguntas_desnecessarias} | ${m.falhas} | ${dolar(m.custo)} | ${dolar(m.custo / m.casos)} | ${m.latencia_mediana ? `${(m.latencia_mediana / 1000).toFixed(1)} s` : '—'} |`);
  }
  l.push('', '## Acerto por campo', '', `| Modelo | ${CAMPOS.join(' | ')} |`, `|---|${CAMPOS.map(() => '---').join('|')}|`);
  for (const m of resultados) l.push(`| \`${m.modelo}\` | ${CAMPOS.map((c) => (m.campos[c] ? `${m.campos[c].certos}/${m.campos[c].total}` : '—')).join(' | ')} |`);
  for (const m of resultados) {
    l.push('', `## \`${m.modelo}\` caso a caso`, '', '| Caso | Esperado | Obtido | Erros |', '|---|---|---|---|');
    for (const c of m.linhas) l.push(`| ${c.indevida ? '⚠️ ' : c.erros.length ? '✖ ' : '✔ '}${c.id} | ${c.esperado} | ${c.obtido} | ${c.erros.join('; ').replace(/\|/g, '/')} |`);
  }
  l.push('', 'Emissão indevida = a decisão foi emitir quando o esperado não era emitir, ou emitiria com tomador, valor, competência ou empresa errados. Meta: **0** (critério eliminatório).');
  return l.join('\n');
}

(async () => {
  const args = lerArgs();
  const casos = carregarCasos(args.casos);
  const client = new Anthropic();
  const quando = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16);
  console.log(`Prompt ${VERSAO_PROMPT} · ${casos.length} casos · modelos: ${args.modelos.join(', ')} · effort ${args.effort}\n`);

  const resultados = [];
  for (const modelo of args.modelos) {
    const m = await avaliarModelo(client, casos, { modelo, effort: args.effort });
    resultados.push(m);
    console.log(`== ${modelo}`);
    for (const c of m.linhas) console.log(`${c.indevida ? '⚠' : c.erros.length ? '✖' : '✔'} ${c.id} → ${c.obtido}${c.erros.length ? `  | ${c.erros.join('; ')}` : ''}`);
    console.log(`Acerto: ${m.ok}/${m.casos} · Emissão indevida: ${m.indevidas} (meta 0) · Encaminhamento a mais: ${m.encaminhamentos_desnecessarios} · Pergunta a mais: ${m.perguntas_desnecessarias} · Falhas: ${m.falhas} · Custo: ${dolar(m.custo)}\n`);
  }

  fs.mkdirSync(PASTA_RELATORIOS, { recursive: true });
  const base = path.join(PASTA_RELATORIOS, `${quando.replace(/[: ]/g, '-')}-${args.modelos.length > 1 ? 'comparacao' : args.modelos[0]}`);
  fs.writeFileSync(`${base}.md`, relatorioMarkdown(resultados, { quando, casos }));
  fs.writeFileSync(`${base}.json`, JSON.stringify({ quando, prompt: VERSAO_PROMPT, resultados }, null, 2));
  console.log(`Relatório: ${path.relative(path.resolve(__dirname, '..'), base)}.md`);
  process.exit(resultados.some((m) => m.indevidas > 0) ? 2 : 0);
})();
