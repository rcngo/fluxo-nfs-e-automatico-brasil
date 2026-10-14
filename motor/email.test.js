const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { remetenteAutenticado, autenticacaoGmail, textoNovo, normalizarEmail } = require('./email');
const { emlParaItem } = require('../scripts/lib/eml');

const EMAILS = path.join(__dirname, '../cenarios/emails');
const eml = (arquivo) => emlParaItem(fs.readFileSync(path.join(EMAILS, arquivo)), { id: 'g1', threadId: 't1' });
const CLIENTE = 'cliente.exemplo@hotmail.com';

test('autenticação: só vale DMARC ou DKIM do próprio domínio do remetente', () => {
  assert.ok(remetenteAutenticado('mx.google.com; dkim=pass header.i=@hotmail.com; spf=pass smtp.mailfrom=x@hotmail.com; dmarc=pass (p=NONE) header.from=hotmail.com', CLIENTE));
  assert.ok(remetenteAutenticado('mx.google.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=hotmail.com', CLIENTE));
  assert.ok(remetenteAutenticado('mx.google.com; dkim=pass header.i=@hotmail.com header.s=s1', CLIENTE)); // DKIM alinhado basta
  assert.ok(remetenteAutenticado('mx.google.com; dmarc=pass header.from=empresa.com.br', 'socio@mail.empresa.com.br')); // subdomínio
  // SPF/DKIM "pass" de outro domínio não provam quem é o remetente.
  assert.ok(!remetenteAutenticado('mx.google.com; dkim=pass header.i=@golpe.exemplo; spf=pass smtp.mailfrom=a@golpe.exemplo; dmarc=fail header.from=hotmail.com', CLIENTE));
  assert.ok(!remetenteAutenticado('mx.google.com; dkim=pass; spf=pass', CLIENTE)); // sem domínio
  assert.ok(!remetenteAutenticado('mx.google.com; dkim=none; spf=softfail; dmarc=fail header.from=hotmail.com', CLIENTE));
  assert.ok(!remetenteAutenticado('mx.google.com; dmarc=pass header.from=hotmail.com', 'cliente@outlook.com'));
  assert.ok(!remetenteAutenticado(undefined, CLIENTE));
  assert.ok(!remetenteAutenticado('mx.google.com; dmarc=pass header.from=hotmail.com', ''));
});

test('vale o Authentication-Results do topo, gravado pelo Gmail', () => {
  assert.strictEqual(autenticacaoGmail(['mx.google.com; dmarc=fail', 'mx.google.com; dmarc=pass header.from=hotmail.com']), 'mx.google.com; dmarc=fail');
  assert.strictEqual(autenticacaoGmail(['Authentication-Results: mx.google.com; dmarc=pass']), 'mx.google.com; dmarc=pass');
  assert.strictEqual(autenticacaoGmail(['spf.protection.outlook.com; dmarc=pass header.from=hotmail.com']), ''); // não é do Gmail
  assert.strictEqual(autenticacaoGmail(undefined), ''); // workflow antigo: não autentica
});

test('cabeçalho forjado pelo remetente: no formato do n8n passaria; pelo topo, não', async () => {
  const item = await eml('cabecalho-forjado.eml');
  // O gatilho do n8n guarda um cabeçalho por nome, e o último vence: o falso.
  assert.ok(remetenteAutenticado(item.headers['authentication-results'], CLIENTE));
  const msg = normalizarEmail(item);
  assert.ok(!remetenteAutenticado(msg.auth_results, msg.remetente));
});

test('e-mails reais de cada tipo viram a mensagem certa', async () => {
  const ok = normalizarEmail(await eml('pedido-completo.eml'));
  assert.strictEqual(ok.remetente, CLIENTE);
  assert.strictEqual(ok.conversa_ref, 't1');
  assert.strictEqual(ok.message_id, '<pedido-completo@hotmail.com>');
  assert.ok(remetenteAutenticado(ok.auth_results, ok.remetente));
  assert.match(ok.texto, /programação de setembro para a Agro Exemplo, CNPJ 75\.768\.426\/0001-99, no valor de R\$ 3\.500,00/);

  for (const arquivo of ['dkim-falha.eml', 'assinado-por-outro-dominio.eml']) {
    const m = normalizarEmail(await eml(arquivo));
    assert.ok(!remetenteAutenticado(m.auth_results, m.remetente), arquivo);
  }

  const html = normalizarEmail(await eml('so-html.eml'));
  assert.strictEqual(textoNovo(html.texto, html.assunto), 'Olá,\n\nPode emitir a nota de programação de setembro para a Agro Exemplo\n(75.768.426/0001-99)\nvalor: R$ 3.500,00');

  const outlook = normalizarEmail(await eml('resposta-outlook-com-citacao.eml'));
  assert.strictEqual(textoNovo(outlook.texto, outlook.assunto), 'Segue o CNPJ: 75.768.426/0001-99\n\nAtt,\nCarlos');

  const gmail = normalizarEmail(await eml('resposta-gmail-com-citacao.eml'));
  assert.strictEqual(textoNovo(gmail.texto, gmail.assunto), 'Sim, pode emitir.');

  const enc = normalizarEmail(await eml('encaminhado.eml'));
  assert.match(textoNovo(enc.texto, enc.assunto), /Boa tarde! Por favor, emitir a nota de programação de setembro no valor de R\$ 3\.500,00\. Nosso CNPJ: 75\.768\.426\/0001-99/);
});

test('remove histórico citado, mas não o conteúdo encaminhado', () => {
  assert.strictEqual(textoNovo('É 75.768.426/0001-99\n\nEm qua., 3 de set. de 2026 às 09:11, NFS <pedidos.exemplo@gmail.com> escreveu:\n> Para emitir a nota...'), 'É 75.768.426/0001-99');
  assert.strictEqual(textoNovo('SIM\r\n\r\n________________________________\r\nDe: pedidos.exemplo@gmail.com\r\nEnviado: quarta'), 'SIM');
  assert.strictEqual(textoNovo('Pedido novo\nsem citação'), 'Pedido novo\nsem citação');
  assert.match(textoNovo('Pode emitir\n\n---------- Forwarded message ---------\nDe: X\n\nNota de R$ 10,00'), /Nota de R\$ 10,00/);
  assert.match(textoNovo('Pode emitir\n\n_____________\nDe: X\nEnviado: hoje\n\nNota de R$ 10,00', 'Fwd: nota'), /Nota de R\$ 10,00/);
});
