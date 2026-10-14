// Servidor HTTP do motor: rotas JSON para o n8n, link "Resolvido" e o painel (/painel).
// Sem dependências externas: recebe o motor e o painel prontos (server.js liga os serviços reais;
// os testes do painel ligam os falsos).

const http = require('node:http');
const { paginaResolver, paginaResultado } = require('./paginas');

async function lerCorpo(req) {
  let corpo = '';
  for await (const parte of req) {
    corpo += parte;
    if (corpo.length > 20_000_000) throw new Error('corpo grande demais');
  }
  return corpo;
}

function criarServidor({ motor, painel }) {
  const rotas = {
    '/processar': motor.processar,
    '/email': motor.processarEmail,
    '/retomar': motor.retomar,
    '/entregue': motor.entregue,
    '/encaminhado': motor.encaminhamentoEnviado,
    '/erro-n8n': motor.erroN8n,
    '/whatsapp/webhook': motor.receberWhatsApp,
    '/whatsapp/verificacao': async (corpo) => motor.verificarWebhookWhatsApp(corpo),
  };

  return http.createServer(async (req, res) => {
    const enviar = (status, corpo) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    const html = (status, corpo) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(corpo);
    };
    const url = new URL(req.url, 'http://motor');
    try {
      if (req.method === 'GET' && url.pathname === '/saude') return enviar(200, { ok: true });

      if (painel && (url.pathname === '/painel' || url.pathname.startsWith('/painel/'))) {
        return await painel.atender(req, res, url, lerCorpo);
      }

      // Abrir o link não muda nada (leitores de e-mail e antivírus abrem links sozinhos):
      // só o botão da página fecha o pedido.
      if (url.pathname === '/resolvido') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t');
          return html(200, paginaResolver(t, await motor.consultarEncaminhamento(t)));
        }
        if (req.method === 'POST') {
          const form = new URLSearchParams(await lerCorpo(req));
          const r = await motor.resolverEncaminhamento(form.get('t'), {
            numero_nota: (form.get('numero_nota') || '').trim().slice(0, 50),
            observacao: (form.get('observacao') || '').trim().slice(0, 1000),
          });
          return html(r.status === 'invalido' ? 404 : 200, paginaResultado(r));
        }
      }

      const rota = req.method === 'POST' && rotas[url.pathname];
      if (!rota) return enviar(404, { erro: 'rota não encontrada' });
      const corpo = await lerCorpo(req);
      enviar(200, await rota(corpo ? JSON.parse(corpo) : {}));
    } catch (e) {
      console.error(req.url, e);
      if (!res.headersSent) enviar(500, { erro: e.message });
      else res.end();
    }
  });
}

module.exports = { criarServidor };
