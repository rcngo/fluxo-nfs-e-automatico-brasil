const test = require('node:test');
const assert = require('node:assert');
const { montarEncaminhamento, MOTIVOS } = require('./encaminhamento');

const base = {
  pedido: { id: '0f9ef0a2-aaaa-bbbb-cccc-000000000000', canal: 'whatsapp', remetente: '+5564999990000' },
  empresa: { razao_social: 'MODELO E CIA LTDA', cnpj: '82571297000100' },
  dados: { tomador: { nome: 'AGRO EXEMPLO', documento: '75768426000199' }, descricao: 'Programação', valor_centavos: 350000, competencia: '2026-09' },
  conversa: [{ direcao: 'entrada', conteudo: 'nota de 3.500\npara Agro Exemplo', criado_em: '2026-10-15T13:00:00Z' }],
  link: 'https://x/resolvido?t=abc',
};

test('assunto, motivo, dados, faltantes, conversa e link', () => {
  const { assunto, texto } = montarEncaminhamento({ ...base, motivo: 'dados_incompletos', detalhe: 'após 2 pergunta(s)', faltantes: ['competencia', 'codigo_desconhecido'] });
  assert.strictEqual(assunto, '[NFS-e] Não consegui emitir — MODELO E CIA LTDA — dados incompletos');
  assert.match(texto, /Motivo: Depois das perguntas/);
  assert.match(texto, /Detalhe: após 2 pergunta\(s\)/);
  assert.match(texto, /Pedido de: \+5564999990000 \(WhatsApp\)/);
  assert.match(texto, /Pedido nº: 0f9ef0a2/);
  assert.match(texto, /• Tomador: AGRO EXEMPLO \(75768426000199\)/);
  assert.match(texto, /• Valor: R\$\s3\.500,00/);
  assert.match(texto, /• o mês\/ano de competência do serviço/);
  assert.match(texto, /• codigo_desconhecido/);
  assert.match(texto, /\[15\/10, 10:00\] Cliente: nota de 3\.500\n    para Agro Exemplo/);
  assert.match(texto, /https:\/\/x\/resolvido\?t=abc$/);
});

test('sem empresa e sem dados', () => {
  const { assunto, texto } = montarEncaminhamento({ ...base, empresa: null, dados: null, motivo: 'remetente_nao_autorizado' });
  assert.match(assunto, /remetente sem cadastro — remetente não autorizado$/);
  assert.match(texto, /Empresa: não identificada/);
  assert.doesNotMatch(texto, /Dados já coletados/);
});

test('nova mensagem e motivo desconhecido', () => {
  assert.match(montarEncaminhamento({ ...base, motivo: 'nova_mensagem' }).assunto, /^\[NFS-e\] Nova mensagem do cliente — MODELO E CIA LTDA — pedido 0f9ef0a2$/);
  assert.match(montarEncaminhamento({ ...base, motivo: 'xyz' }).texto, /A aplicação não conseguiu concluir o pedido/);
  // Todo motivo tem título e explicação.
  for (const [k, [titulo, explicacao]] of Object.entries(MOTIVOS)) assert.ok(titulo && explicacao, k);
});

test('caso tributário especial lista cada razão', () => {
  const { assunto, texto } = montarEncaminhamento({
    ...base,
    motivo: 'caso_tributario_especial',
    detalhe: 'tomador pessoa jurídica e o serviço "programação" está marcado como sujeito a retenção para esse tipo de tomador; o cliente fala de imposto ou retenção ("retenção")',
  });
  assert.match(assunto, /— caso tributário especial$/);
  assert.match(texto, /Confira a tributação e emita manualmente/);
  assert.match(texto, /Por que é especial:\n• tomador pessoa jurídica e o serviço "programação" está marcado como sujeito a retenção para esse tipo de tomador\n• o cliente fala de imposto ou retenção \("retenção"\)/);
  assert.doesNotMatch(texto, /Detalhe:/);
});
