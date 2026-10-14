// Canal WhatsApp (Cloud API oficial da Meta): assinatura do webhook, normalização das mensagens
// recebidas e janela de 24 h para responder com texto livre. Puro (sem rede): o n8n recebe o
// webhook e envia as respostas; o motor decide.

const crypto = require('node:crypto');

// A Meta assina o corpo bruto do webhook com o App Secret: X-Hub-Signature-256: sha256=<hex>.
function assinaturaValida(corpo, cabecalho, segredo) {
  if (!segredo || !cabecalho) return false;
  const m = String(cabecalho).match(/^sha256=([0-9a-f]{64})$/i);
  if (!m) return false;
  const esperado = crypto.createHmac('sha256', segredo).update(Buffer.from(corpo || '', 'utf8')).digest();
  return crypto.timingSafeEqual(esperado, Buffer.from(m[1], 'hex'));
}

// Celular brasileiro: o WhatsApp às vezes identifica o número sem o 9 da frente (5564 9999-0000
// vira 556499990000). Devolve as formas E.164 a procurar no cadastro.
function variantesTelefone(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  if (!d) return [];
  const formas = new Set([`+${d}`]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') formas.add(`+${d.slice(0, 4)}${d.slice(5)}`);
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) formas.add(`+${d.slice(0, 4)}9${d.slice(4)}`);
  return [...formas];
}

const MIDIA = { audio: 'áudio', voice: 'áudio', image: 'imagem', video: 'vídeo', document: 'arquivo', sticker: 'figurinha' };

// Uma mensagem recebida (value.messages[i]) → mensagem para processar(). null = ignorar
// (reação, aviso do sistema, tipo que não é conversa).
function normalizarMensagem(m, contato) {
  const base = {
    canal: 'whatsapp',
    remetente: `+${m.from}`,
    conversa_ref: `+${m.from}`,
    message_id: m.id,
    nome_perfil: (contato && contato.profile && contato.profile.name) || null,
  };
  if (m.type === 'text') return { ...base, texto: (m.text && m.text.body) || '' };
  if (m.type === 'button') return { ...base, texto: (m.button && m.button.text) || '' };
  if (m.type === 'interactive') {
    const i = m.interactive || {};
    return { ...base, texto: (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '' };
  }
  if (MIDIA[m.type]) {
    const dados = m[m.type] || {};
    const midia = { tipo: m.type, descricao: MIDIA[m.type], id: dados.id, mime: dados.mime_type || null, nome: dados.filename || null, legenda: dados.caption || null };
    return { ...base, texto: [`[${midia.descricao}${midia.nome ? `: ${midia.nome}` : ''}]`, midia.legenda].filter(Boolean).join(' '), midia };
  }
  // Localização, contato, pedido de catálogo e outros: o escritório vê pela mensagem.
  if (['location', 'contacts', 'order', 'unsupported'].includes(m.type)) {
    return { ...base, texto: `[mensagem do tipo ${m.type}]`, midia: { tipo: m.type, descricao: 'mensagem que não é texto', id: null } };
  }
  return null; // reaction, system, ephemeral...
}

// Corpo do webhook (JSON da Cloud API) → { mensagens, falhas_envio }.
// falhas_envio: status "failed" de mensagens que o fluxo enviou (ex.: fora da janela de 24 h).
function lerWebhook(payload) {
  const mensagens = [];
  const falhas = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return { mensagens, falhas_envio: falhas };
  for (const entrada of payload.entry || []) {
    for (const mudanca of entrada.changes || []) {
      if (mudanca.field !== 'messages') continue;
      const v = mudanca.value || {};
      for (const m of v.messages || []) {
        const contato = (v.contacts || []).find((c) => c.wa_id === m.from);
        const msg = normalizarMensagem(m, contato);
        if (msg) mensagens.push(msg);
      }
      for (const s of v.statuses || []) {
        if (s.status === 'failed') falhas.push({ para: s.recipient_id, wamid: s.id, erros: (s.errors || []).map((e) => `${e.code} ${e.title}`) });
      }
    }
  }
  return { mensagens, falhas_envio: falhas };
}

// Fora da janela de 24 h desde a última mensagem do cliente, a Meta só aceita modelo aprovado.
// Margem de 30 min para não perder a janela entre a decisão e o envio.
const JANELA_MS = 23.5 * 3_600_000;
const dentroDaJanela = (ultimaDoCliente, agora) => Boolean(ultimaDoCliente) && agora - new Date(ultimaDoCliente) < JANELA_MS;

// Modelo (template) cadastrado na Meta para mensagens fora da janela, categoria UTILITY:
//   nome: nfse_atualizacao · idioma: pt_BR
//   corpo: "Atualização do seu pedido de nota fiscal: {{1}}"
// A Meta recusa parâmetro com quebra de linha, tabulação ou mais de 4 espaços seguidos.
const MODELO = { nome: 'nfse_atualizacao', idioma: 'pt_BR' };
function modeloAtualizacao(texto) {
  const parametro = String(texto).replace(/\s*\n+\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim().slice(0, 1000);
  return { ...MODELO, parametros: [parametro] };
}

module.exports = { assinaturaValida, variantesTelefone, lerWebhook, dentroDaJanela, modeloAtualizacao, MODELO };
