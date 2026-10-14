// Converte um arquivo .eml no item que o workflow do n8n entrega ao motor (POST /email),
// para testar com e-mails de verdade sem o Gmail:
//   - o mesmo parser e o mesmo formato do gatilho do Gmail no n8n (parseRawEmail do
//     n8n-nodes-base, n8n 2.40.5: mailparser 3.9.3; cabeçalho repetido → vale o último);
//   - `autenticacao`: todos os Authentication-Results na ordem da mensagem, como a API do Gmail
//     devolve em format=metadata (o nó "Gmail: autenticação" do workflow).

const { simpleParser } = require('mailparser');

async function emlParaItem(raw, { id, threadId }) {
  const p = await simpleParser(raw);
  const headers = {};
  for (const h of p.headerLines) headers[h.key] = h.line;
  const autenticacao = p.headerLines
    .filter((h) => h.key === 'authentication-results')
    .map((h) => h.line.replace(/^authentication-results:\s*/i, '').replace(/\s+/g, ' ').trim());
  return {
    id,
    threadId,
    ...p,
    headers,
    headerLines: undefined,
    attachments: undefined,
    date: p.date ? p.date.toISOString() : p.date,
    autenticacao,
  };
}

module.exports = { emlParaItem };
