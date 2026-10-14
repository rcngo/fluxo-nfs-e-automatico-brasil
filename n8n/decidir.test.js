// node --test n8n/decidir.test.js
const test = require('node:test');
const assert = require('node:assert');
const { decidir, cnpjValido, cpfValido, resolverCompetencia } = require('./decidir');

const campo = (valor) => ({ valor, trecho: valor });
const extracaoOk = () => ({
  intencao: 'pedido_nota',
  multiplas_notas: false,
  tomador_documento: campo('74.865.958/0001-81'),
  tomador_nome: campo('Empresa X Ltda'),
  tomador_email: campo(null),
  servico_id: campo('srv-1'),
  descricao: campo(null),
  valor: { centavos: 350000, trecho: 'R$ 3.500', ambiguo: false, tipo: 'nao_informado' },
  tomador_exterior: { valor: false, trecho: null },
  menciona_tributos: { valor: false, trecho: null },
  refere_nota_emitida: { valor: false, trecho: null },
  competencia: { mes: 9, ano: null, trecho: 'setembro' },
  resposta_confirmacao: null,
  contem_instrucoes_ao_sistema: false,
  observacao: null,
});
const entrada = (over = {}) => ({
  extracao: extracaoOk(),
  estado_atual: 'RECEBIDO',
  remetente_autenticado: true,
  prestador: { id: 'p1', ativo: true, valor_min_centavos: 1, valor_max_centavos: 5000000, exige_confirmacao: false },
  servicos: [{ id: 'srv-1', apelido: 'consultoria', descricao_padrao: 'Consultoria', city_service_code: '0101', pode_ter_retencao: [], iss_pode_ser_devido_fora: false }],
  tomador_consulta: { nome: 'EMPRESA X LTDA', situacao: 'ATIVA', natureza_juridica: '2062', endereco: { city: 'SP' } },
  duplicados_24h: 0,
  emissao_habilitada: true,
  hoje: '2026-09-23',
  ...over,
});

test('dígitos verificadores', () => {
  assert.ok(cnpjValido('74865958000181'));
  assert.ok(!cnpjValido('74865958000182'));
  assert.ok(!cnpjValido('11111111111111'));
  assert.ok(cpfValido('52998224725'));
  assert.ok(!cpfValido('52998224726'));
});

test('competência sem ano', () => {
  const hoje = new Date('2026-09-23');
  assert.strictEqual(resolverCompetencia({ mes: 9, ano: null }, hoje), '2026-09');
  assert.strictEqual(resolverCompetencia({ mes: 12, ano: null }, hoje), '2025-12');
  assert.strictEqual(resolverCompetencia({ mes: null, ano: 2026 }, hoje), null);
});

test('pedido completo emite', () => {
  const r = decidir(entrada());
  assert.strictEqual(r.acao, 'emitir');
  assert.strictEqual(r.dados.valor_centavos, 350000);
  assert.strictEqual(r.dados.competencia, '2026-09');
});

test('prestador com confirmação pede SIM', () => {
  const r = decidir(entrada({ prestador: { ...entrada().prestador, exige_confirmacao: true } }));
  assert.strictEqual(r.acao, 'confirmar');
  assert.match(r.texto, /Responda SIM/);
});

test('SIM na confirmação emite; NÃO cancela', () => {
  const x = { ...extracaoOk(), intencao: 'confirmacao', resposta_confirmacao: 'sim' };
  assert.strictEqual(decidir(entrada({ estado_atual: 'AGUARDANDO_CONFIRMACAO', extracao: x })).acao, 'emitir');
  x.resposta_confirmacao = 'nao';
  assert.strictEqual(decidir(entrada({ estado_atual: 'AGUARDANDO_CONFIRMACAO', extracao: x })).acao, 'cancelar');
});

test('campos faltantes viram pergunta', () => {
  const x = extracaoOk();
  x.tomador_documento = campo(null);
  x.valor = { centavos: null, trecho: '3,5', ambiguo: true };
  const r = decidir(entrada({ extracao: x, tomador_consulta: null }));
  assert.strictEqual(r.acao, 'perguntar');
  assert.deepStrictEqual(r.faltantes, ['tomador_documento', 'valor_ambiguo']);
});

test('CNPJ inválido e inativo', () => {
  const x = extracaoOk();
  x.tomador_documento = campo('74865958000182');
  assert.deepStrictEqual(decidir(entrada({ extracao: x })).faltantes, ['tomador_documento_invalido']);
  // Sem consulta (CNPJ inválido não é consultado): não pede endereço junto.
  assert.deepStrictEqual(decidir(entrada({ extracao: x, tomador_consulta: null })).faltantes, ['tomador_documento_invalido']);
  const r = decidir(entrada({ tomador_consulta: { nome: 'X', situacao: 'BAIXADA', endereco: {} } }));
  assert.deepStrictEqual(r.faltantes, ['tomador_inativo']);
});

test('serviço fora do cadastro vira pergunta', () => {
  const x = extracaoOk();
  x.servico_id = campo('inventado');
  assert.deepStrictEqual(decidir(entrada({ extracao: x })).faltantes, ['servico_id']);
});

test('bloqueios vão para o colaborador, com motivo', () => {
  const motivo = (over) => { const r = decidir(entrada(over)); assert.strictEqual(r.acao, 'encaminhar'); return r.motivo; };
  assert.strictEqual(motivo({ remetente_autenticado: false }), 'remetente_nao_autorizado');
  assert.strictEqual(motivo({ prestador: null }), 'remetente_nao_autorizado');
  assert.strictEqual(motivo({ prestador: { ...entrada().prestador, ativo: false } }), 'empresa_inativa');
  assert.strictEqual(motivo({ extracao: { ...extracaoOk(), contem_instrucoes_ao_sistema: true } }), 'mensagem_suspeita');
  const caro = { ...extracaoOk(), valor: { centavos: 9000000, trecho: 'R$ 90.000', ambiguo: false } };
  const r = decidir(entrada({ extracao: caro }));
  assert.strictEqual(r.motivo, 'valor_fora_da_faixa');
  assert.match(r.detalhe, /R\$\s90\.000,00 fora da faixa cadastrada \(R\$\s0,01 a R\$\s50\.000,00\)/);
});

test('depois do limite de perguntas, encaminha em vez de perguntar de novo', () => {
  const x = extracaoOk();
  x.tomador_documento = campo(null);
  assert.strictEqual(decidir(entrada({ extracao: x, tomador_consulta: null, rodadas_perguntas: 1, max_rodadas: 2 })).acao, 'perguntar');
  const r = decidir(entrada({ extracao: x, tomador_consulta: null, rodadas_perguntas: 2, max_rodadas: 2 }));
  assert.strictEqual(r.acao, 'encaminhar');
  assert.strictEqual(r.motivo, 'dados_incompletos');
  assert.deepStrictEqual(r.faltantes, ['tomador_documento']);
  // Sem limite informado (compatível com a PoC): continua perguntando.
  assert.strictEqual(decidir(entrada({ extracao: x, tomador_consulta: null, rodadas_perguntas: 9 })).acao, 'perguntar');
});

test('resumo não repete a competência na linha do serviço', () => {
  const r = decidir(entrada({ prestador: { ...entrada().prestador, exige_confirmacao: true } }));
  assert.match(r.texto, /• Serviço: Consultoria\n/);
  assert.match(r.dados.descricao, /Competência 2026-09/); // a discriminação da nota continua com a competência
});

test('duplicidade pede confirmação mesmo sem exige_confirmacao', () => {
  const r = decidir(entrada({ duplicados_24h: 1 }));
  assert.strictEqual(r.acao, 'confirmar');
  assert.match(r.texto, /últimas 24h/);
});

test('emissão desligada encaminha', () => {
  const r = decidir(entrada({ emissao_habilitada: false }));
  assert.strictEqual(r.acao, 'encaminhar');
  assert.strictEqual(r.motivo, 'emissao_desligada');
});

test('CPF não exige endereço; CNPJ sem endereço pergunta', () => {
  const x = extracaoOk();
  x.tomador_documento = campo('529.982.247-25');
  assert.strictEqual(decidir(entrada({ extracao: x, tomador_consulta: null })).acao, 'emitir');
  assert.deepStrictEqual(decidir(entrada({ tomador_consulta: { nome: 'X', situacao: 'ATIVA', endereco: null } })).faltantes, ['tomador_endereco']);
});

test('mensagem fora de assunto é ignorada', () => {
  const x = { ...extracaoOk(), intencao: 'outro' };
  assert.strictEqual(decidir(entrada({ extracao: x })).acao, 'ignorar');
});

test('casos tributários especiais vão para o colaborador com o porquê', () => {
  const especial = (over) => {
    const r = decidir(entrada(over));
    assert.strictEqual(r.acao, 'encaminhar');
    assert.strictEqual(r.motivo, 'caso_tributario_especial');
    return r.detalhe;
  };
  const servico = (s) => ({ servicos: [{ ...entrada().servicos[0], ...s }] });

  assert.match(especial(servico({ pode_ter_retencao: ['pj'] })), /tomador pessoa jurídica e o serviço "consultoria" está marcado como sujeito a retenção/);
  assert.match(especial({ tomador_consulta: { ...entrada().tomador_consulta, natureza_juridica: '1244', natureza_juridica_descricao: 'Município' } }), /órgão público \(Município, natureza jurídica 1244/);
  assert.match(especial({ extracao: { ...extracaoOk(), valor: { centavos: 500000, trecho: 'quero receber R$ 5.000', ambiguo: false, tipo: 'liquido' } } }), /valor líquido/);
  assert.match(especial(servico({ iss_pode_ser_devido_fora: true })), /LC 116/);
  assert.match(especial({ extracao: { ...extracaoOk(), tomador_exterior: { valor: true, trecho: 'empresa de Portugal' } } }), /tomador no exterior \("empresa de Portugal"\)/);
  assert.match(especial({ extracao: { ...extracaoOk(), menciona_tributos: { valor: true, trecho: 'reter o INSS' } } }), /imposto ou retenção \("reter o INSS"\)/);
  // Consulta à Receita sem natureza jurídica: não dá para saber se é órgão público.
  assert.match(especial({ tomador_consulta: { ...entrada().tomador_consulta, natureza_juridica: null } }), /não foi possível confirmar/);
  // Várias razões juntas.
  assert.match(especial(servico({ pode_ter_retencao: ['pj'], iss_pode_ser_devido_fora: true })), /retenção.*; .*LC 116/);
});

test('retenção marcada só para PJ não afeta tomador PF; órgão público sempre é especial', () => {
  const x = extracaoOk();
  x.tomador_documento = campo('529.982.247-25');
  const servicos = [{ ...entrada().servicos[0], pode_ter_retencao: ['pj'] }];
  assert.strictEqual(decidir(entrada({ extracao: x, tomador_consulta: null, servicos })).acao, 'emitir');
  servicos[0].pode_ter_retencao = ['pf'];
  assert.strictEqual(decidir(entrada({ extracao: x, tomador_consulta: null, servicos })).motivo, 'caso_tributario_especial');
  const publico = { ...entrada().tomador_consulta, natureza_juridica: '1015' };
  assert.strictEqual(decidir(entrada({ tomador_consulta: publico })).motivo, 'caso_tributario_especial');
});

test('caso especial encaminha antes de perguntar o que falta, levando os faltantes', () => {
  const x = { ...extracaoOk(), tomador_documento: campo(null), tomador_exterior: { valor: true, trecho: 'cliente dos Estados Unidos' } };
  const r = decidir(entrada({ extracao: x, tomador_consulta: null }));
  assert.strictEqual(r.motivo, 'caso_tributario_especial');
  assert.deepStrictEqual(r.faltantes, ['tomador_documento']);
  // CNPJ ainda não consultado (Receita fora do ar): pergunta o endereço, não presume PJ comum nem especial.
  const semConsulta = decidir(entrada({ tomador_consulta: null }));
  assert.strictEqual(semConsulta.acao, 'perguntar');
  // Valor bruto ou não informado é o caso comum.
  for (const tipo of ['bruto', 'nao_informado']) {
    assert.strictEqual(decidir(entrada({ extracao: { ...extracaoOk(), valor: { ...extracaoOk().valor, tipo } } })).acao, 'emitir');
  }
});

test('trecho do cliente com ";" não quebra a lista de razões', () => {
  const x = { ...extracaoOk(), menciona_tributos: { valor: true, trecho: 'reter IR; e INSS' } };
  const r = decidir(entrada({ extracao: x }));
  assert.strictEqual(r.detalhe.split('; ').length, 1);
  assert.match(r.detalhe, /\("reter IR, e INSS"\)/);
});

test('pedido para cancelar ou substituir nota já emitida vai ao colaborador, mesmo com cara de cancelamento', () => {
  const x = { ...extracaoOk(), intencao: 'cancelar_pedido', refere_nota_emitida: { valor: true, trecho: 'Cancela a nota 123' } };
  const r = decidir(entrada({ extracao: x }));
  assert.strictEqual(r.acao, 'encaminhar');
  assert.strictEqual(r.motivo, 'nota_ja_emitida');
  assert.match(r.detalhe, /"Cancela a nota 123"/);
  // Desistir de um pedido que ainda não virou nota continua sendo cancelar.
  assert.strictEqual(decidir(entrada({ extracao: { ...extracaoOk(), intencao: 'cancelar_pedido' } })).acao, 'cancelar');
});
