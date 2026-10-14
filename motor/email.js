// Tratamento do e-mail recebido: autenticação do remetente e remoção do histórico citado.
// normalizarEmail() recebe o item do gatilho do Gmail no n8n como ele chega.

// Gmail grava o resultado de SPF/DKIM/DMARC no cabeçalho Authentication-Results.
// Só vale se o resultado for do PRÓPRIO domínio do remetente (alinhado): DMARC pass com
// header.from do domínio, ou DKIM pass assinado pelo domínio. SPF e DKIM "pass" de outro
// domínio não provam nada (quem falsifica o From assina com o próprio domínio).
function remetenteAutenticado(authResults, remetente) {
  const a = (authResults || '').toLowerCase();
  const dominio = String(remetente || '').toLowerCase().split('@')[1];
  if (!dominio) return false;
  const alinhado = (d) => d === dominio || d.endsWith(`.${dominio}`) || dominio.endsWith(`.${d}`);
  for (const parte of a.split(';')) {
    const dmarc = parte.match(/\bdmarc=pass\b.*\bheader\.from=([a-z0-9.-]+)/);
    if (dmarc && alinhado(dmarc[1])) return true;
    const dkim = parte.match(/\bdkim=pass\b.*\bheader\.(?:i=[^@\s]*@|d=)([a-z0-9.-]+)/);
    if (dkim && alinhado(dkim[1])) return true;
  }
  return false;
}

// O resultado que vale é o do topo da mensagem, gravado pelo servidor do Gmail na entrega
// (authserv-id mx.google.com). Os de baixo vêm de outros servidores, ou do próprio remetente,
// que pode escrever um "Authentication-Results: ... dmarc=pass" falso no e-mail.
// `lista`: todos os Authentication-Results na ordem da mensagem (API do Gmail, format=metadata).
function autenticacaoGmail(lista) {
  const topo = (lista || [])[0];
  if (!topo) return '';
  const valor = String(topo).replace(/^\s*authentication-results:\s*/i, '');
  return /^\s*mx\.google\.com\b/i.test(valor) ? valor : '';
}

// Numa resposta, o cliente de e-mail repete a conversa anterior abaixo do texto novo.
// O histórico já está no banco; aqui fica só o que o cliente escreveu agora.
const MARCAS_CITACAO = [
  /^\s*Em .{5,200} escreveu:\s*$/m,                 // Gmail pt-BR
  /^\s*On .{5,200} wrote:\s*$/m,                    // Gmail en
  /^\s*_{10,}\s*$/m,                                // Outlook/Hotmail (linha de sublinhados)
  /^\s*-{2,}\s*Mensagem original\s*-{2,}/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*(De|From):\s.+\n\s*(Enviado|Enviada|Sent|Data|Date):/im,
];

// Encaminhamento ("ENC:", "Fwd:"): o pedido costuma estar justamente no e-mail encaminhado.
const ASSUNTO_ENCAMINHADO = /^\s*(fwd?|enc|tr|encaminhad[ao])\s*:/i;
const CORPO_ENCAMINHADO = /-{5,}\s*(Forwarded message|Mensagem encaminhada)\s*-{5,}/i;

function textoNovo(texto, assunto = '') {
  // Espaço não separável (&nbsp; do HTML) vira espaço comum.
  let t = (texto || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
  if (ASSUNTO_ENCAMINHADO.test(assunto) || CORPO_ENCAMINHADO.test(t)) return t.trim();
  for (const re of MARCAS_CITACAO) {
    const m = t.match(re);
    if (m) t = t.slice(0, m.index);
  }
  // Linhas citadas com ">".
  t = t
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return t.trim();
}

/**
 * Item do gatilho do Gmail (n8n, simple: false) → mensagem para processar().
 * @param {object} j  { id, threadId, messageId, from, subject, text, html, autenticacao: string[] }
 */
function normalizarEmail(j) {
  const remetente = ((j.from && j.from.value && j.from.value[0] && j.from.value[0].address) || '').toLowerCase();
  return {
    canal: 'email',
    remetente,
    conversa_ref: j.threadId,
    message_id: j.messageId || j.id,
    gmail_id: j.id,
    assunto: j.subject || '',
    // E-mail só em HTML: o mailparser (o mesmo do n8n) já gera o texto, com a citação em "> ".
    texto: j.text || '',
    auth_results: autenticacaoGmail(j.autenticacao),
  };
}

// Mensagens que o próprio fluxo envia (encaminhamentos e alertas) não são pedidos.
const ASSUNTO_DO_FLUXO = /^\s*(re:\s*)?\[NFS-e\]/i;

module.exports = { remetenteAutenticado, autenticacaoGmail, textoNovo, normalizarEmail, ASSUNTO_DO_FLUXO };
