const test = require('node:test');
const assert = require('node:assert');
const { montarPayload, emitir, consultarPorReferencia, CAMPOS_PAYLOAD_COMUM } = require('./nfeio');
const { decidir } = require('../n8n/decidir');

// Regra fixa 3: o produto não calcula imposto. No caso comum, nada de imposto vai à NFE.io.
const IMPOSTO = /iss|withheld|retention|rate|aliquot|deduction|irrf|inss|pis|cofins|csll|tax(?!Number)/i;

function chaves(obj, prefixo = '') {
  return Object.entries(obj).flatMap(([k, v]) => [`${prefixo}${k}`, ...(v && typeof v === 'object' ? chaves(v, `${prefixo}${k}.`) : [])]);
}

const campo = (valor) => ({ valor, trecho: valor });
const servico = { id: 'srv-1', apelido: 'programação', descricao_padrao: 'Serviço de Programador', city_service_code: '010201', federal_service_code: '010201', nbs_code: '115021000', pode_ter_retencao: [], iss_pode_ser_devido_fora: false };

function pedidoComum(doc, consulta) {
  return decidir({
    extracao: {
      intencao: 'pedido_nota', multiplas_notas: false,
      tomador_documento: campo(doc), tomador_nome: campo('Fulano'), tomador_email: campo(null),
      servico_id: campo('srv-1'), descricao: campo(null),
      valor: { centavos: 350000, trecho: 'R$ 3.500', ambiguo: false, tipo: 'nao_informado' },
      tomador_exterior: { valor: false, trecho: null }, menciona_tributos: { valor: false, trecho: null },
      competencia: { mes: 9, ano: 2026, trecho: 'setembro' },
      resposta_confirmacao: null, contem_instrucoes_ao_sistema: false, observacao: null,
    },
    estado_atual: 'RECEBIDO', remetente_autenticado: true,
    prestador: { id: 'p1', ativo: true, valor_min_centavos: 1, valor_max_centavos: 5000000, exige_confirmacao: false },
    servicos: [servico], tomador_consulta: consulta, duplicados_24h: 0, emissao_habilitada: true, hoje: '2026-10-15',
  });
}

test('pedido comum não envia nenhum campo de imposto à NFE.io (PJ e PF)', () => {
  const casos = [
    pedidoComum('74865958000181', { nome: 'EMPRESA TESTE LTDA', situacao: 'ATIVA', natureza_juridica: '2062', endereco: { country: 'BRA', city: { code: '3550308', name: 'São Paulo' }, state: 'SP', additionalInformation: '' } }),
    pedidoComum('52998224725', null),
  ];
  for (const decisao of casos) {
    assert.strictEqual(decisao.acao, 'emitir');
    const payload = montarPayload(decisao.dados, servico, 'pedido-1');
    const extras = Object.keys(payload).filter((k) => !CAMPOS_PAYLOAD_COMUM.includes(k));
    assert.deepStrictEqual(extras, [], 'campos fora da lista do caso comum');
    assert.deepStrictEqual(chaves(payload).filter((k) => IMPOSTO.test(k)), [], 'campo com cara de imposto');
  }
});

test('a lista do caso comum não tem campo de imposto', () => {
  assert.deepStrictEqual(CAMPOS_PAYLOAD_COMUM.filter((k) => IMPOSTO.test(k)), []);
});

test('competência e referência do pedido vão no payload', () => {
  const payload = montarPayload(pedidoComum('52998224725', null).dados, servico, '0f9ef0a2-aaaa');
  assert.strictEqual(payload.accrualOn, '2026-09-01');
  assert.strictEqual(payload.externalId, '0f9ef0a2-aaaa');
});

// fetch falso: cada rota devolve um status (ou lança um erro de rede com o código dado).
function comFetch(rotas, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes) => {
    const chave = `${opcoes.method} ${new URL(url).pathname}`;
    const [, r] = Object.entries(rotas).find(([padrao]) => new RegExp(padrao).test(chave)) || [null, { status: 404 }];
    if (r.rede) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.rede } });
    return new Response(JSON.stringify(r.corpo ?? {}), { status: r.status });
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

const DEV = {
  'GET /v2/companies/c1$': { status: 200, corpo: { company: { stateTaxes: [] } } },
  'GET /v2/companies/c1/municipaltaxes': { status: 200, corpo: { municipalTaxes: [{ environment: 'Development' }] } },
};
const DEV_OK = { ...DEV, 'POST /v1/companies/c1/serviceinvoices': { status: 202, corpo: { id: 'n1' } } };
const tipoDoErro = (rotas) => comFetch(rotas, () => emitir('c1', {}).then(() => 'ok', (e) => e.tipo));

test('falhas da NFE.io são classificadas: rejeitada, bloqueada, indisponível ou incerta', async () => {
  assert.strictEqual(await tipoDoErro({ ...DEV, 'POST /v1/companies/c1/serviceinvoices': { status: 202, corpo: { id: 'n1' } } }), 'ok');
  assert.strictEqual(await tipoDoErro({ ...DEV, 'POST ': { status: 400, corpo: { message: 'cityServiceCode inválido' } } }), 'rejeitada');
  assert.strictEqual(await tipoDoErro({ ...DEV, 'POST ': { status: 429 } }), 'indisponivel');
  assert.strictEqual(await tipoDoErro({ ...DEV, 'POST ': { status: 500 } }), 'incerta');
  assert.strictEqual(await tipoDoErro({ ...DEV, 'POST ': { rede: 'ECONNRESET' } }), 'incerta');
  assert.strictEqual(await tipoDoErro({ ...DEV, 'POST ': { rede: 'ECONNREFUSED' } }), 'indisponivel');
  // Trava: NFE.io fora do ar antes do envio = indisponível; ambiente de produção = bloqueada.
  assert.strictEqual(await tipoDoErro({ 'GET ': { status: 503 } }), 'indisponivel');
  assert.strictEqual(await tipoDoErro({ 'GET ': { rede: 'ENOTFOUND' } }), 'indisponivel');
  assert.strictEqual(await tipoDoErro({ ...DEV, 'GET /v2/companies/c1/municipaltaxes': { status: 200, corpo: { municipalTaxes: [{ environment: 'Production' }] } } }), 'bloqueada');
  assert.strictEqual(await tipoDoErro({ 'GET ': { status: 401 } }), 'bloqueada');
});

test('nota real (Production) só com a liberação formal: variável ligada e decisão registrada', async () => {
  const PROD = { ...DEV, 'GET /v2/companies/c1/municipaltaxes': { status: 200, corpo: { municipalTaxes: [{ environment: 'Production' }] } }, 'POST /v1/companies/c1/serviceinvoices': { status: 202, corpo: { id: 'n1' } } };
  const MISTO = { ...PROD, 'GET /v2/companies/c1/municipaltaxes': { status: 200, corpo: { municipalTaxes: [{ environment: 'Production' }, { environment: 'Development' }] } } };
  const antes = { h: process.env.EMISSAO_PRODUCAO_HABILITADA, d: process.env.EMISSAO_PRODUCAO_DECISAO };
  const definir = (h, d) => {
    for (const [k, v] of [['EMISSAO_PRODUCAO_HABILITADA', h], ['EMISSAO_PRODUCAO_DECISAO', d]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  try {
    definir(undefined, undefined);
    assert.strictEqual(await tipoDoErro(PROD), 'bloqueada');
    definir('true', '');
    assert.strictEqual(await tipoDoErro(PROD), 'bloqueada'); // sem a decisão registrada não vale
    definir('sim', 'Ata de 01/11/2026');
    assert.strictEqual(await tipoDoErro(PROD), 'bloqueada'); // só "true" liga
    definir('true', 'Ata de 01/11/2026');
    assert.strictEqual(await tipoDoErro(PROD), 'ok');
    assert.strictEqual(await tipoDoErro(DEV_OK), 'ok');
    assert.strictEqual(await tipoDoErro(MISTO), 'bloqueada');
    assert.strictEqual(await tipoDoErro({ ...PROD, 'GET /v2/companies/c1$': { status: 200, corpo: { company: { stateTaxes: [{ id: 'ie' }] } } } }), 'bloqueada');
  } finally {
    definir(antes.h, antes.d);
  }
});

test('consulta pela referência: achou, não existe ou sem resposta', async () => {
  const consulta = (r) => comFetch({ 'GET /v1/companies/c1/serviceinvoices/external/p1': r }, () => consultarPorReferencia('c1', 'p1').then((n) => n, (e) => e.tipo));
  // Formato real (teste externo de 13/10/2026): 200 com lista; lista vazia quando não existe.
  const nota = { id: 'n1', externalId: 'p1', flowStatus: 'Issued' };
  assert.deepStrictEqual(await consulta({ status: 200, corpo: { serviceInvoices: [nota] } }), [nota]);
  assert.deepStrictEqual(await consulta({ status: 200, corpo: { serviceInvoices: [], page: 1 } }), []);
  assert.deepStrictEqual(await consulta({ status: 200, corpo: { serviceInvoices: [{ ...nota, externalId: 'outro' }] } }), []);
  // Formato do spec: objeto único, ou 404.
  assert.deepStrictEqual(await consulta({ status: 200, corpo: nota }), [nota]);
  assert.deepStrictEqual(await consulta({ status: 404 }), []);
  assert.strictEqual(await consulta({ status: 200, corpo: { algo: 1 } }), 'indisponivel');
  assert.strictEqual(await consulta({ status: 503 }), 'indisponivel');
  assert.strictEqual(await consulta({ rede: 'ETIMEDOUT' }), 'indisponivel');
});
