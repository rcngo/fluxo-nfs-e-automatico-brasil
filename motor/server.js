// Liga o motor aos serviços reais e sobe o servidor HTTP (motor/http.js). O n8n chama as rotas
// JSON; o colaborador abre /resolvido pelo link do e-mail e o painel em /painel. A lógica fica em app.js.
//
//   POST /processar  { canal, remetente, conversa_ref, message_id, gmail_id, texto, auth_results }
//   POST /email      item do gatilho do Gmail no n8n + autenticacao (motor/email.js) → como /processar
//   POST /retomar    → [ respostas ] (notas que terminaram de emitir + prazos vencidos)
//   POST /entregue   { pedido_id }  (n8n confirma que a nota foi enviada ao cliente)
//   POST /encaminhado { encaminhamento_id }  (n8n confirma que enviou a mensagem ao colaborador)
//   POST /erro-n8n   { workflow, no, mensagem, execucao, url } → alerta ao colaborador padrão
//   POST /whatsapp/webhook     { corpo (texto bruto), assinatura (X-Hub-Signature-256) } → { valido, mensagens }
//   POST /whatsapp/verificacao { modo, token, desafio } (GET de verificação da Meta) → { ok, desafio }
//   GET  /resolvido?t=...           página com o botão "Marcar como resolvido"
//   POST /resolvido                 (formulário da página) fecha o pedido
//   GET  /saude
//   /painel/...                     painel do escritório (motor/painel.js), com login
//
// As respostas de /processar e /retomar podem trazer `encaminhar: { para_email, assunto, texto, link }`:
// o n8n envia essa mensagem ao colaborador.

const path = require('node:path');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { extrair } = require('../n8n/extrair');
const nfeio = require('./nfeio');
const { consultarCnpj } = require('./brasilapi');
const { criarMotor } = require('./app');
const { criarServidor } = require('./http');
const { criarPainel } = require('./painel');

// Emissão real: a variável sozinha não basta, precisa da referência da decisão formal (motor/nfeio.js).
if (process.env.EMISSAO_PRODUCAO_HABILITADA === 'true' && !nfeio.producaoLiberada()) {
  console.error('EMISSAO_PRODUCAO_HABILITADA=true sem EMISSAO_PRODUCAO_DECISAO: registre a decisão formal do escritório ou desligue a variável.');
  process.exit(1);
}
const instalacao = { producao: nfeio.producaoLiberada(), decisao: (process.env.EMISSAO_PRODUCAO_DECISAO || '').trim() };
console.log(instalacao.producao
  ? `ATENÇÃO: emissão REAL liberada (NFE.io Production). Decisão: ${instalacao.decisao}`
  : 'Emissão somente de teste (NFE.io Development).');

const claude = new Anthropic();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const relogio = { agora: () => new Date() };
const pastaDominio = process.env.PASTA_DOMINIO || path.resolve(__dirname, '../saida/dominio');
const motor = criarMotor({
  db,
  extrator: { extrair: (contexto) => extrair(claude, contexto) },
  nfeio,
  consultarCnpj,
  relogio,
  pastaDominio,
  esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
  urlPublica: (process.env.URL_PUBLICA || 'http://localhost:3010').replace(/\/$/, ''),
  // infra/secrets.env: App Secret do app na Meta e o token escolhido para verificar o webhook.
  whatsapp: { appSecret: process.env.WHATSAPP_APP_SECRET, verifyToken: process.env.WHATSAPP_VERIFY_TOKEN },
});

const painel = criarPainel({ db, motor, nfeio, relogio, instalacao, cookieSeguro: /^https:/.test(process.env.URL_PUBLICA || '') });

criarServidor({ motor, painel })
  .listen(Number(process.env.PORT || 3000), () => console.log(`motor ouvindo na porta ${process.env.PORT || 3000}`));
