// Importa cadastros a partir de planilhas CSV (uma por tipo) numa pasta:
//   colaboradores.csv · empresas.csv · servicos.csv · remetentes.csv · tomadores.csv
// Todas são opcionais; o formato está em docs/modelo-cadastro/README.md.
//
// Uso:
//   npm run importar -- <pasta> --previa    mostra o que seria feito e os erros, sem gravar
//   npm run importar -- <pasta>             grava as linhas válidas (as com erro são ignoradas)
//
// Banco: DATABASE_URL ou, na máquina de desenvolvimento, o Postgres do compose (infra/.env).

const fs = require('node:fs');
const path = require('node:path');
const { cnpjValido, cpfValido } = require('../n8n/decidir');
const { digitos, reaisParaCentavos, simNao, telefone, emailValido, tiposRetencao } = require('../motor/cadastro');

const ARQUIVOS = ['colaboradores', 'empresas', 'servicos', 'remetentes', 'tomadores'];

const OBRIGATORIAS = {
  colaboradores: ['nome', 'email'],
  empresas: ['cnpj', 'razao_social', 'nfeio_company_id', 'municipio_ibge', 'valor_maximo'],
  servicos: ['empresa_cnpj', 'apelido', 'descricao_padrao', 'codigo_servico_municipal'],
  remetentes: ['empresa_cnpj', 'canal', 'identificador'],
  tomadores: ['empresa_cnpj', 'documento', 'nome'],
};

// ---------------------------------------------------------------------------
// Leitura do CSV (aceita ";" do Excel em português e "," ; aspas; BOM)
// ---------------------------------------------------------------------------

function lerCsv(texto) {
  const t = texto.replace(/^﻿/, '');
  const primeira = t.split(/\r?\n/, 1)[0];
  const sep = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (aspas) {
      if (ch === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (ch === '"') aspas = false;
      else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) { linha.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo); linhas.push(linha); linha = []; campo = '';
    } else campo += ch;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  const [cabecalho = [], ...dados] = linhas.filter((l) => l.some((c) => c.trim() !== ''));
  const colunas = cabecalho.map((c) => c.trim().toLowerCase());
  return dados.map((l, i) => ({
    linha: i + 2, // linha 1 = cabeçalho
    campos: Object.fromEntries(colunas.map((c, j) => [c, (l[j] || '').trim()])),
  }));
}

// ---------------------------------------------------------------------------
// Validação (pura): planilhas + o que já existe no banco → plano de gravação e erros
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, {linha:number, campos:object}[]>} planilhas  por nome de arquivo (sem .csv)
 * @param {object} existentes  { colaboradores: Set(email), empresas: Set(cnpj), servicos: Set('cnpj|apelido'),
 *                               remetentes: Set('cnpj|canal|id'), tomadores: Set('cnpj|doc') }
 */
function validarCadastro(planilhas, existentes) {
  const erros = [];
  const plano = Object.fromEntries(ARQUIVOS.map((a) => [a, []]));
  const erro = (arquivo, linha, msg) => erros.push({ arquivo: `${arquivo}.csv`, linha, msg });

  const ok = (arquivo, { linha, campos }) => {
    const faltando = OBRIGATORIAS[arquivo].filter((c) => !campos[c]);
    if (faltando.length) {
      erro(arquivo, linha, `coluna obrigatória vazia: ${faltando.join(', ')}`);
      return false;
    }
    return true;
  };
  const acao = (conjunto, chave) => (conjunto.has(chave) ? 'atualiza' : 'novo');

  // Colaboradores
  const emailsColab = new Set(existentes.colaboradores);
  const vistosColab = new Set();
  let padroes = 0;
  for (const r of planilhas.colaboradores || []) {
    if (!ok('colaboradores', r)) continue;
    const email = r.campos.email.toLowerCase();
    const padrao = simNao(r.campos.padrao, false);
    const whatsapp = r.campos.whatsapp ? telefone(r.campos.whatsapp) : null;
    if (!emailValido(email)) { erro('colaboradores', r.linha, `e-mail inválido: ${r.campos.email}`); continue; }
    if (r.campos.whatsapp && !whatsapp) { erro('colaboradores', r.linha, `WhatsApp inválido: ${r.campos.whatsapp} (use DDD + número)`); continue; }
    if (padrao === undefined) { erro('colaboradores', r.linha, `padrao deve ser sim ou não: ${r.campos.padrao}`); continue; }
    if (vistosColab.has(email)) { erro('colaboradores', r.linha, `e-mail repetido na planilha: ${email}`); continue; }
    if (padrao && ++padroes > 1) { erro('colaboradores', r.linha, 'só um colaborador pode ser o padrão'); continue; }
    vistosColab.add(email);
    plano.colaboradores.push({ linha: r.linha, acao: acao(existentes.colaboradores, email), dados: { nome: r.campos.nome, email, whatsapp, padrao } });
    emailsColab.add(email);
  }

  // Empresas
  const cnpjsValidos = new Set(existentes.empresas);
  const cnpjsComErro = new Set();
  const vistasEmp = new Set();
  for (const r of planilhas.empresas || []) {
    const cnpj = digitos(r.campos.cnpj);
    const falhar = (msg) => { erro('empresas', r.linha, msg); if (cnpj) cnpjsComErro.add(cnpj); };
    if (!ok('empresas', r)) { if (cnpj) cnpjsComErro.add(cnpj); continue; }
    const min = r.campos.valor_minimo ? reaisParaCentavos(r.campos.valor_minimo) : 1;
    const max = reaisParaCentavos(r.campos.valor_maximo);
    const exige = simNao(r.campos.exige_confirmacao, true);
    const colab = (r.campos.colaborador_email || '').toLowerCase() || null;
    if (!cnpjValido(cnpj)) { falhar(`CNPJ inválido: ${r.campos.cnpj}`); continue; }
    if (vistasEmp.has(cnpj)) { falhar(`CNPJ repetido na planilha: ${cnpj}`); continue; }
    if (!/^\d{7}$/.test(digitos(r.campos.municipio_ibge))) { falhar(`código IBGE do município deve ter 7 dígitos: ${r.campos.municipio_ibge}`); continue; }
    if (Number.isNaN(min) || Number.isNaN(max) || max === null) { falhar('valor mínimo/máximo inválido (ex.: 50.000,00)'); continue; }
    if (min > max) { falhar('valor mínimo maior que o máximo'); continue; }
    if (exige === undefined) { falhar(`exige_confirmacao deve ser sim ou não: ${r.campos.exige_confirmacao}`); continue; }
    if (colab && !emailsColab.has(colab)) { falhar(`colaborador não encontrado (cadastre em colaboradores.csv): ${colab}`); continue; }
    vistasEmp.add(cnpj);
    plano.empresas.push({
      linha: r.linha,
      acao: acao(existentes.empresas, cnpj),
      dados: {
        cnpj, razao_social: r.campos.razao_social, nfeio_company_id: r.campos.nfeio_company_id,
        municipio_ibge: digitos(r.campos.municipio_ibge), valor_min_centavos: min, valor_max_centavos: max,
        exige_confirmacao: exige, colaborador_email: colab,
      },
    });
    cnpjsValidos.add(cnpj);
  }

  // Dependentes de empresa
  const empresaOk = (arquivo, r) => {
    const cnpj = digitos(r.campos.empresa_cnpj);
    if (cnpjsComErro.has(cnpj)) { erro(arquivo, r.linha, `a empresa ${cnpj} tem erro em empresas.csv`); return null; }
    if (!cnpjsValidos.has(cnpj)) { erro(arquivo, r.linha, `empresa não cadastrada: ${r.campos.empresa_cnpj}`); return null; }
    return cnpj;
  };

  const vistosServ = new Set();
  for (const r of planilhas.servicos || []) {
    if (!ok('servicos', r)) continue;
    const cnpj = empresaOk('servicos', r);
    if (!cnpj) continue;
    const apelido = r.campos.apelido.toLowerCase();
    const nacional = digitos(r.campos.codigo_tributacao_nacional) || null;
    const nbs = digitos(r.campos.nbs) || null;
    if (nacional && nacional.length !== 6) { erro('servicos', r.linha, `código de tributação nacional deve ter 6 dígitos: ${r.campos.codigo_tributacao_nacional}`); continue; }
    if (nbs && nbs.length !== 9) { erro('servicos', r.linha, `NBS deve ter 9 dígitos: ${r.campos.nbs}`); continue; }
    // Colunas da E3 (opcionais): ausentes na planilha = não mexe no que já está no banco.
    const retencao = 'retencao' in r.campos ? tiposRetencao(r.campos.retencao) : null;
    const issFora = 'iss_fora_do_municipio' in r.campos ? simNao(r.campos.iss_fora_do_municipio, false) : null;
    if (retencao === undefined) { erro('servicos', r.linha, `retencao deve listar PF, PJ e/ou órgão público (ex.: "PJ / órgão público"): ${r.campos.retencao}`); continue; }
    if (issFora === undefined) { erro('servicos', r.linha, `iss_fora_do_municipio deve ser sim ou não: ${r.campos.iss_fora_do_municipio}`); continue; }
    const chave = `${cnpj}|${apelido}`;
    if (vistosServ.has(chave)) { erro('servicos', r.linha, `serviço repetido para a empresa: ${apelido}`); continue; }
    vistosServ.add(chave);
    plano.servicos.push({
      linha: r.linha,
      acao: acao(existentes.servicos, chave),
      dados: { empresa_cnpj: cnpj, apelido, descricao_padrao: r.campos.descricao_padrao, city_service_code: r.campos.codigo_servico_municipal, federal_service_code: nacional, nbs_code: nbs, pode_ter_retencao: retencao, iss_pode_ser_devido_fora: issFora },
    });
  }

  const vistosRem = new Set();
  for (const r of planilhas.remetentes || []) {
    if (!ok('remetentes', r)) continue;
    const cnpj = empresaOk('remetentes', r);
    if (!cnpj) continue;
    const canal = r.campos.canal.toLowerCase();
    let id;
    if (canal === 'email') {
      id = r.campos.identificador.toLowerCase();
      if (!emailValido(id)) { erro('remetentes', r.linha, `e-mail inválido: ${r.campos.identificador}`); continue; }
    } else if (canal === 'whatsapp') {
      id = telefone(r.campos.identificador);
      if (!id) { erro('remetentes', r.linha, `telefone inválido: ${r.campos.identificador} (use DDD + número)`); continue; }
    } else { erro('remetentes', r.linha, `canal deve ser email ou whatsapp: ${r.campos.canal}`); continue; }
    const chave = `${cnpj}|${canal}|${id}`;
    if (vistosRem.has(chave)) { erro('remetentes', r.linha, `remetente repetido para a empresa: ${id}`); continue; }
    vistosRem.add(chave);
    plano.remetentes.push({ linha: r.linha, acao: acao(existentes.remetentes, chave), dados: { empresa_cnpj: cnpj, canal, identificador: id, nome: r.campos.nome || null } });
  }

  const vistosTom = new Set();
  for (const r of planilhas.tomadores || []) {
    if (!ok('tomadores', r)) continue;
    const cnpj = empresaOk('tomadores', r);
    if (!cnpj) continue;
    const doc = digitos(r.campos.documento);
    const email = (r.campos.email || '').toLowerCase() || null;
    if (!(doc.length === 14 ? cnpjValido(doc) : doc.length === 11 ? cpfValido(doc) : false)) { erro('tomadores', r.linha, `CNPJ/CPF inválido: ${r.campos.documento}`); continue; }
    if (email && !emailValido(email)) { erro('tomadores', r.linha, `e-mail inválido: ${r.campos.email}`); continue; }
    const chave = `${cnpj}|${doc}`;
    if (vistosTom.has(chave)) { erro('tomadores', r.linha, `tomador repetido para a empresa: ${doc}`); continue; }
    vistosTom.add(chave);
    plano.tomadores.push({ linha: r.linha, acao: acao(existentes.tomadores, chave), dados: { empresa_cnpj: cnpj, documento: doc, nome: r.campos.nome, email } });
  }

  return { plano, erros };
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

async function carregarExistentes(c) {
  const conj = async (sql) => new Set((await c.query(sql)).rows.map((r) => r.k));
  return {
    colaboradores: await conj('SELECT email AS k FROM colaboradores'),
    empresas: await conj('SELECT cnpj AS k FROM prestadores'),
    servicos: await conj(`SELECT p.cnpj || '|' || s.apelido AS k FROM prestador_servicos s JOIN prestadores p ON p.id = s.prestador_id`),
    remetentes: await conj(`SELECT p.cnpj || '|' || r.canal || '|' || r.identificador AS k FROM prestador_remetentes r JOIN prestadores p ON p.id = r.prestador_id`),
    tomadores: await conj(`SELECT p.cnpj || '|' || t.documento AS k FROM tomadores t JOIN prestadores p ON p.id = t.prestador_id`),
  };
}

async function aplicarCadastro(c, plano) {
  const idEmpresa = async (cnpj) => (await c.query('SELECT id FROM prestadores WHERE cnpj = $1', [cnpj])).rows[0].id;
  await c.query('BEGIN');
  try {
    for (const { dados: d } of plano.colaboradores) {
      if (d.padrao) await c.query('UPDATE colaboradores SET padrao = false WHERE padrao AND email <> $1', [d.email]);
      await c.query(
        `INSERT INTO colaboradores (nome, email, whatsapp, padrao) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, whatsapp = EXCLUDED.whatsapp, padrao = EXCLUDED.padrao, ativo = true`,
        [d.nome, d.email, d.whatsapp, d.padrao],
      );
    }
    for (const { dados: d } of plano.empresas) {
      await c.query(
        `INSERT INTO prestadores (cnpj, razao_social, nfeio_company_id, municipio_ibge, valor_min_centavos, valor_max_centavos, exige_confirmacao, colaborador_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT id FROM colaboradores WHERE email = $8))
         ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social, nfeio_company_id = EXCLUDED.nfeio_company_id,
           municipio_ibge = EXCLUDED.municipio_ibge, valor_min_centavos = EXCLUDED.valor_min_centavos,
           valor_max_centavos = EXCLUDED.valor_max_centavos, exige_confirmacao = EXCLUDED.exige_confirmacao,
           colaborador_id = EXCLUDED.colaborador_id`,
        [d.cnpj, d.razao_social, d.nfeio_company_id, d.municipio_ibge, d.valor_min_centavos, d.valor_max_centavos, d.exige_confirmacao, d.colaborador_email],
      );
    }
    for (const { dados: d } of plano.servicos) {
      await c.query(
        `INSERT INTO prestador_servicos (prestador_id, apelido, descricao_padrao, city_service_code, federal_service_code, nbs_code, pode_ter_retencao, iss_pode_ser_devido_fora)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::text[], '{}'), COALESCE($8::boolean, false))
         ON CONFLICT (prestador_id, apelido) DO UPDATE SET descricao_padrao = EXCLUDED.descricao_padrao,
           city_service_code = EXCLUDED.city_service_code, federal_service_code = EXCLUDED.federal_service_code,
           nbs_code = EXCLUDED.nbs_code, ativo = true,
           pode_ter_retencao = COALESCE($7::text[], prestador_servicos.pode_ter_retencao),
           iss_pode_ser_devido_fora = COALESCE($8::boolean, prestador_servicos.iss_pode_ser_devido_fora)`,
        [await idEmpresa(d.empresa_cnpj), d.apelido, d.descricao_padrao, d.city_service_code, d.federal_service_code, d.nbs_code, d.pode_ter_retencao, d.iss_pode_ser_devido_fora],
      );
    }
    for (const { dados: d } of plano.remetentes) {
      await c.query(
        `INSERT INTO prestador_remetentes (prestador_id, canal, identificador, nome) VALUES ($1, $2, $3, $4)
         ON CONFLICT (prestador_id, canal, identificador) DO UPDATE SET nome = EXCLUDED.nome, ativo = true`,
        [await idEmpresa(d.empresa_cnpj), d.canal, d.identificador, d.nome],
      );
    }
    for (const { dados: d } of plano.tomadores) {
      await c.query(
        `INSERT INTO tomadores (prestador_id, documento, nome, email) VALUES ($1, $2, $3, $4)
         ON CONFLICT (prestador_id, documento) DO UPDATE SET nome = EXCLUDED.nome, email = EXCLUDED.email`,
        [await idEmpresa(d.empresa_cnpj), d.documento, d.nome, d.email],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function lerPasta(pasta) {
  const planilhas = {};
  for (const nome of ARQUIVOS) {
    const arquivo = path.join(pasta, `${nome}.csv`);
    if (fs.existsSync(arquivo)) planilhas[nome] = lerCsv(fs.readFileSync(arquivo, 'utf8'));
  }
  return planilhas;
}

function relatorio({ plano, erros }, previa) {
  const linhas = [];
  for (const nome of ARQUIVOS) {
    const itens = plano[nome];
    const errosArq = erros.filter((e) => e.arquivo === `${nome}.csv`);
    if (!itens.length && !errosArq.length) continue;
    const novos = itens.filter((i) => i.acao === 'novo').length;
    linhas.push(`${nome}.csv: ${itens.length} válida(s) (${novos} nova(s), ${itens.length - novos} atualização(ões)) · ${errosArq.length} com erro`);
  }
  if (erros.length) {
    linhas.push('', 'Linhas com erro (não serão importadas):');
    for (const e of erros) linhas.push(`  ${e.arquivo} linha ${e.linha}: ${e.msg}`);
  }
  linhas.push('', previa ? 'Prévia: nada foi gravado. Rode sem --previa para importar as linhas válidas.' : 'Linhas válidas gravadas.');
  return linhas.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const previa = args.includes('--previa');
  const pasta = args.find((a) => !a.startsWith('--'));
  if (!pasta || !fs.existsSync(pasta)) throw new Error('uso: npm run importar -- <pasta-com-os-csv> [--previa]');
  const planilhas = lerPasta(pasta);
  if (!Object.keys(planilhas).length) throw new Error(`nenhum CSV encontrado em ${pasta} (${ARQUIVOS.map((a) => `${a}.csv`).join(', ')})`);

  const { Pool } = require('pg');
  const { urlBanco } = require('./lib/banco');
  const pool = new Pool({ connectionString: urlBanco('nfs') });
  const c = await pool.connect();
  try {
    const resultado = validarCadastro(planilhas, await carregarExistentes(c));
    if (!previa) await aplicarCadastro(c, resultado.plano);
    console.log(relatorio(resultado, previa));
  } finally {
    c.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { lerCsv, validarCadastro, reaisParaCentavos, telefone, tiposRetencao, aplicarCadastro, carregarExistentes };
