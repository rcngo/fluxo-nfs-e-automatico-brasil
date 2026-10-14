// Páginas HTML do link "Resolvido" (sem dependências; o painel completo vem na E8).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function layout(titulo, corpo) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)}</title>
<style>
  :root { color-scheme: light dark; --fundo:#f6f6f4; --cartao:#fff; --texto:#1d1d1b; --suave:#5f5e5a; --borda:#dcdad3; --acento:#1f6f5c; }
  @media (prefers-color-scheme: dark) { :root { --fundo:#141413; --cartao:#1d1d1b; --texto:#ecebe6; --suave:#a6a49c; --borda:#3a3936; --acento:#5cc2a3; } }
  body { margin:0; background:var(--fundo); color:var(--texto); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:560px; margin:48px auto; padding:0 16px; }
  .cartao { background:var(--cartao); border:1px solid var(--borda); border-radius:12px; padding:24px; }
  h1 { font-size:20px; margin:0 0 12px; } p { margin:8px 0; } .suave { color:var(--suave); font-size:14px; }
  label { display:block; font-size:14px; margin:16px 0 4px; }
  input, textarea { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid var(--borda); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  button { margin-top:20px; background:var(--acento); color:#fff; border:0; border-radius:8px; padding:10px 18px; font:inherit; font-weight:600; cursor:pointer; }
</style></head>
<body><main><div class="cartao">${corpo}</div></main></body></html>`;
}

function paginaResolver(token, info) {
  if (info.status === 'invalido') {
    return layout('Link inválido', '<h1>Link inválido</h1><p>Este link não corresponde a nenhum pedido. Confira se copiou o endereço completo do e-mail.</p>');
  }
  if (info.status === 'ja_resolvido') {
    return layout('Pedido já resolvido', `<h1>Este pedido já foi marcado como resolvido</h1><p>${esc(info.assunto)}</p>`);
  }
  return layout('Marcar como resolvido', `
    <h1>Marcar pedido como resolvido</h1>
    <p>${esc(info.assunto)}</p>
    <p class="suave">Pedido de ${esc(info.remetente)}${info.empresa ? ` · ${esc(info.empresa)}` : ''}</p>
    <form method="post" action="/resolvido">
      <input type="hidden" name="t" value="${esc(token)}">
      <label for="numero_nota">Número da nota emitida (opcional)</label>
      <input id="numero_nota" name="numero_nota" maxlength="50" autocomplete="off">
      <label for="observacao">Observação (opcional)</label>
      <textarea id="observacao" name="observacao" rows="3" maxlength="1000"></textarea>
      <button type="submit">Marcar como resolvido</button>
    </form>
    <p class="suave">Depois de resolvido, novas mensagens do cliente nesta conversa voltam a ser atendidas automaticamente.</p>`);
}

function paginaResultado(r) {
  if (r.status === 'resolvido') return layout('Resolvido', '<h1>Pedido marcado como resolvido</h1><p>Obrigado. Pode fechar esta página.</p>');
  if (r.status === 'ja_resolvido') return layout('Pedido já resolvido', '<h1>Este pedido já tinha sido marcado como resolvido</h1>');
  return layout('Link inválido', '<h1>Link inválido</h1><p>Este link não corresponde a nenhum pedido.</p>');
}

module.exports = { paginaResolver, paginaResultado };
