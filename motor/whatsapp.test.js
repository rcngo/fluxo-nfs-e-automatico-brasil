const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assinaturaValida, variantesTelefone, lerWebhook, dentroDaJanela, modeloAtualizacao } = require('./whatsapp');

const PAYLOADS = path.join(__dirname, '../cenarios/whatsapp-payloads');
const payload = (arquivo) => JSON.parse(fs.readFileSync(path.join(PAYLOADS, arquivo), 'utf8'));

test('assinatura do webhook (X-Hub-Signature-256) sobre o corpo bruto', () => {
  const corpo = JSON.stringify(payload('texto.json'));
  const assinar = (c, s) => `sha256=${crypto.createHmac('sha256', s).update(c).digest('hex')}`;
  assert.ok(assinaturaValida(corpo, assinar(corpo, 'segredo'), 'segredo'));
  assert.ok(!assinaturaValida(corpo, assinar(corpo, 'outro'), 'segredo'));
  assert.ok(!assinaturaValida(`${corpo} `, assinar(corpo, 'segredo'), 'segredo')); // corpo alterado
  assert.ok(!assinaturaValida(corpo, assinar(corpo, 'segredo').replace('sha256=', 'sha1='), 'segredo'));
  assert.ok(!assinaturaValida(corpo, undefined, 'segredo'));
  assert.ok(!assinaturaValida(corpo, assinar(corpo, ''), '')); // sem App Secret configurado: recusa tudo
});

test('celular brasileiro com e sem o 9', () => {
  assert.deepStrictEqual(variantesTelefone('556499990000'), ['+556499990000', '+5564999990000']);
  assert.deepStrictEqual(variantesTelefone('+55 64 99999-0000'), ['+5564999990000', '+556499990000']);
  assert.deepStrictEqual(variantesTelefone('+556433334444'), ['+556433334444']); // fixo: sem variante
  assert.deepStrictEqual(variantesTelefone('+14155550100'), ['+14155550100']);
  assert.deepStrictEqual(variantesTelefone(''), []);
});

test('mensagens do webhook: texto, mídia, reação e falha de envio', () => {
  const [texto] = lerWebhook(payload('texto.json')).mensagens;
  assert.deepStrictEqual(
    { canal: texto.canal, remetente: texto.remetente, conversa_ref: texto.conversa_ref, nome: texto.nome_perfil, midia: texto.midia },
    { canal: 'whatsapp', remetente: '+556499990000', conversa_ref: '+556499990000', nome: 'Carlos Exemplo', midia: undefined },
  );
  assert.match(texto.message_id, /^wamid\./);
  assert.match(texto.texto, /R\$ 3\.500,00/);

  const [audio] = lerWebhook(payload('audio.json')).mensagens;
  assert.deepStrictEqual(audio.midia, { tipo: 'audio', descricao: 'áudio', id: '1234567890123456', mime: 'audio/ogg; codecs=opus', nome: null, legenda: null });
  assert.strictEqual(audio.texto, '[áudio]');

  const [imagem] = lerWebhook(payload('imagem-com-legenda.json')).mensagens;
  assert.strictEqual(imagem.texto, '[imagem] segue o pedido da Agro Exemplo');
  const [doc] = lerWebhook(payload('documento.json')).mensagens;
  assert.strictEqual(doc.texto, '[arquivo: pedido-setembro.pdf]');

  assert.deepStrictEqual(lerWebhook(payload('reacao.json')), { mensagens: [], falhas_envio: [] });
  assert.deepStrictEqual(lerWebhook(payload('status-falha-fora-da-janela.json')).falhas_envio[0].erros, ['131047 Re-engagement message']);
  assert.deepStrictEqual(lerWebhook({ object: 'page' }), { mensagens: [], falhas_envio: [] });
});

test('janela de 24 h e modelo fora dela', () => {
  const agora = new Date('2026-10-15T10:00:00-03:00');
  assert.ok(dentroDaJanela('2026-10-14T11:00:00-03:00', agora)); // 23 h atrás
  assert.ok(!dentroDaJanela('2026-10-14T10:20:00-03:00', agora)); // 23h40: dentro da margem de segurança
  assert.ok(!dentroDaJanela(null, agora));
  const m = modeloAtualizacao('Como não recebemos resposta,\nencaminhei seu pedido.\n\n• item    um');
  assert.deepStrictEqual(m, { nome: 'nfse_atualizacao', idioma: 'pt_BR', parametros: ['Como não recebemos resposta, · encaminhei seu pedido. · • item um'] });
});
