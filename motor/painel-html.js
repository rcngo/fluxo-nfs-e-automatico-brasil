// HTML do painel (sem dependências). Todo texto vindo do banco ou do cliente passa por esc().

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const reais = (c) => (Number.isInteger(c) || /^\d+$/.test(String(c)) ? (Number(c) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '');
const quando = (d) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const valorReais = (c) => (c === null || c === undefined || c === '' ? '' : (Number(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }));

const ESTADOS = {
  RECEBIDO: 'Recebido',
  AGUARDANDO_CLIENTE: 'Aguardando o cliente',
  AGUARDANDO_CONFIRMACAO: 'Aguardando o SIM',
  VALIDADO: 'Validado',
  EMITINDO: 'Emitindo',
  AGUARDANDO_EMISSOR: 'Aguardando a NFE.io',
  EMITIDA: 'Emitida',
  ENTREGUE: 'Entregue',
  ENCAMINHADO: 'Com o escritório',
  RESOLVIDO_MANUAL: 'Resolvido pelo escritório',
  RECUSADO: 'Recusado',
  ERRO_EMISSAO: 'Erro na emissão',
  EXPIRADO: 'Expirado',
  CANCELADO: 'Cancelado',
};
const TOM = { ENCAMINHADO: 'alerta', AGUARDANDO_EMISSOR: 'alerta', EMITIDA: 'ok', ENTREGUE: 'ok', RESOLVIDO_MANUAL: 'neutro', CANCELADO: 'neutro' };
const estado = (e) => `<span class="selo ${TOM[e] || ''}">${esc(ESTADOS[e] || e)}</span>`;

function layout({ titulo, colaborador, csrf, ativo, corpo, aviso }) {
  const menu = colaborador
    ? `<nav>
        ${[['pedidos', 'Pedidos'], ['empresas', 'Empresas'], ['colaboradores', 'Colaboradores'], ['configuracoes', 'Configurações']]
          .map(([k, t]) => `<a href="/painel/${k}"${ativo === k ? ' aria-current="page"' : ''}>${t}</a>`).join('')}
        <span class="espaco"></span>
        <a href="/painel/senha"${ativo === 'senha' ? ' aria-current="page"' : ''}>${esc(colaborador.nome)}</a>
        <form method="post" action="/painel/sair" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Sair</button></form>
      </nav>`
    : '';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)} · NFS-e</title>
<style>
  :root { color-scheme: light dark; --fundo:#f6f6f4; --cartao:#fff; --texto:#1d1d1b; --suave:#5f5e5a; --borda:#dcdad3; --acento:#1f6f5c; --alerta:#a15c07; --alerta-fundo:#fdf1dc; --ok:#1f6f5c; --ok-fundo:#e3f1ec; --erro:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --fundo:#141413; --cartao:#1d1d1b; --texto:#ecebe6; --suave:#a6a49c; --borda:#3a3936; --acento:#5cc2a3; --alerta:#f0b45a; --alerta-fundo:#3a2c14; --ok:#5cc2a3; --ok-fundo:#16302a; --erro:#f97066; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--fundo); color:var(--texto); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  nav { display:flex; gap:4px; align-items:center; flex-wrap:wrap; padding:10px 16px; background:var(--cartao); border-bottom:1px solid var(--borda); }
  nav a, button.link { color:var(--texto); text-decoration:none; padding:6px 10px; border-radius:8px; background:none; border:0; font:inherit; cursor:pointer; }
  nav a[aria-current] { background:var(--fundo); font-weight:600; }
  .espaco { flex:1; }
  main { max-width:1100px; margin:24px auto; padding:0 16px; }
  h1 { font-size:22px; margin:0 0 16px; } h2 { font-size:17px; margin:24px 0 8px; }
  .cartao { background:var(--cartao); border:1px solid var(--borda); border-radius:12px; padding:16px 20px; margin-bottom:16px; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--borda); vertical-align:top; }
  th { font-size:13px; color:var(--suave); font-weight:600; } tr:last-child td { border-bottom:0; }
  td a { color:var(--acento); }
  .suave { color:var(--suave); font-size:13px; }
  .selo { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; background:var(--fundo); white-space:nowrap; }
  .selo.alerta { background:var(--alerta-fundo); color:var(--alerta); } .selo.ok { background:var(--ok-fundo); color:var(--ok); }
  .numeros { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:16px; }
  .numero { background:var(--cartao); border:1px solid var(--borda); border-radius:12px; padding:12px 16px; }
  .numero b { display:block; font-size:24px; font-variant-numeric:tabular-nums; }
  form.filtros, .linha { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
  label { display:block; font-size:13px; color:var(--suave); margin:10px 0 4px; }
  input, select, textarea { padding:7px 9px; border:1px solid var(--borda); border-radius:8px; background:var(--cartao); color:inherit; font:inherit; }
  input[type=checkbox] { width:auto; }
  .campo { min-width:160px; } .campo input, .campo select, .campo textarea { width:100%; }
  button { background:var(--acento); color:#fff; border:0; border-radius:8px; padding:8px 16px; font:inherit; font-weight:600; cursor:pointer; }
  button.secundario { background:transparent; color:var(--acento); border:1px solid var(--borda); }
  form.inline { display:inline; margin:0; }
  .aviso { border-radius:10px; padding:10px 14px; margin-bottom:16px; background:var(--ok-fundo); color:var(--ok); }
  .aviso.erro { background:var(--alerta-fundo); color:var(--erro); }
  .conversa p { margin:0 0 10px; white-space:pre-wrap; } .conversa .saida { color:var(--suave); }
  pre { white-space:pre-wrap; word-break:break-word; font-size:12px; margin:0; }
  .marcas label { display:inline-flex; gap:6px; align-items:center; margin-right:14px; color:var(--texto); font-size:14px; }
</style></head>
<body>${menu}<main>${aviso ? `<div class="aviso${aviso.erro ? ' erro' : ''}" role="status">${esc(aviso.texto)}</div>` : ''}${corpo}</main></body></html>`;
}

const csrfCampo = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const opcoes = (lista, atual) => lista.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(atual ?? '') ? ' selected' : ''}>${esc(t)}</option>`).join('');
const marca = (nome, ligado, texto) => `<label><input type="checkbox" name="${esc(nome)}" value="1"${ligado ? ' checked' : ''}> ${esc(texto)}</label>`;
const campo = (rotulo, html) => `<div class="campo"><label>${esc(rotulo)}</label>${html}</div>`;
const entrada = (nome, valor, extra = '') => `<input name="${esc(nome)}" value="${esc(valor)}" ${extra}>`;

// ---------------------------------------------------------------------------

function paginaLogin({ erro, email, semSenhas }) {
  return layout({
    titulo: 'Entrar',
    aviso: erro ? { erro: true, texto: erro } : null,
    corpo: `<div class="cartao" style="max-width:380px;margin:40px auto">
      <h1>Painel de NFS-e</h1>
      <form method="post" action="/painel/entrar">
        <label for="email">E-mail</label><input id="email" name="email" type="email" value="${esc(email)}" autocomplete="username" required style="width:100%">
        <label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required style="width:100%">
        <p><button type="submit">Entrar</button></p>
      </form>
      ${semSenhas ? '<p class="suave">Nenhum colaborador tem senha ainda. No servidor: <code>npm run painel:senha -- &lt;e-mail&gt;</code></p>' : ''}
    </div>`,
  });
}

function paginaPedidos(ctx, { pedidos, filtros, empresas, numeros, pendentes, backupAtrasado = false }) {
  const n = numeros;
  const cards = [
    ['Pedidos no mês', n.pedidos],
    ['Emitidas automaticamente', n.emitidas],
    ['Com o escritório agora', n.pendentes],
    ['Resolvidos pelo escritório', n.resolvidos],
  ].map(([t, v]) => `<div class="numero"><span class="suave">${t}</span><b>${v}</b></div>`).join('');
  const motivos = n.motivos.length
    ? `<p class="suave">Encaminhados no mês por motivo: ${n.motivos.map((m) => `${esc(m.titulo)} (${m.n})`).join(' · ')}</p>`
    : '';
  const linhas = pedidos.map((p) => `<tr>
      <td><a href="/painel/pedidos/${esc(p.id)}">${esc(p.id.slice(0, 8))}</a><div class="suave">${quando(p.criado_em)}</div></td>
      <td>${estado(p.estado)}${p.motivo_encaminhamento ? `<div class="suave">${esc(p.motivo_encaminhamento)}</div>` : ''}</td>
      <td>${esc(p.empresa || '—')}</td>
      <td>${esc(p.tomador || p.tomador_documento || '—')}</td>
      <td style="text-align:right">${reais(p.valor_centavos)}</td>
      <td>${esc(p.canal === 'whatsapp' ? 'WhatsApp' : 'E-mail')}<div class="suave">${esc(p.remetente)}</div></td>
    </tr>`).join('');
  return layout({
    ...ctx,
    titulo: 'Pedidos',
    ativo: 'pedidos',
    corpo: `<h1>Pedidos</h1>
      <div class="numeros">${cards}</div>${motivos}
      ${backupAtrasado ? '<div class="aviso erro">O backup diário está atrasado ou falhou. Veja em <a href="/painel/configuracoes">Configurações</a> e avise o responsável pelo servidor.</div>' : ''}
      ${pendentes ? `<div class="aviso erro">${pendentes} pedido(s) com o escritório aguardando resolução. <a href="/painel/pedidos?estado=ENCAMINHADO">Ver</a></div>` : ''}
      <form class="filtros cartao" method="get" action="/painel/pedidos">
        ${campo('Estado', `<select name="estado"><option value="">Todos</option>${opcoes(Object.entries(ESTADOS), filtros.estado)}</select>`)}
        ${campo('Empresa', `<select name="empresa"><option value="">Todas</option>${opcoes(empresas.map((e) => [e.id, e.razao_social]), filtros.empresa)}</select>`)}
        ${campo('De', entrada('de', filtros.de, 'type="date"'))}
        ${campo('Até', entrada('ate', filtros.ate, 'type="date"'))}
        <div><button type="submit">Filtrar</button></div>
      </form>
      <div class="cartao">${pedidos.length ? `<table>
        <thead><tr><th>Pedido</th><th>Situação</th><th>Empresa</th><th>Tomador</th><th style="text-align:right">Valor</th><th>Canal</th></tr></thead>
        <tbody>${linhas}</tbody></table>` : '<p class="suave">Nenhum pedido com esses filtros.</p>'}
        ${pedidos.length === 200 ? '<p class="suave">Mostrando os 200 mais recentes; use os filtros para ver outros.</p>' : ''}
      </div>`,
  });
}

function paginaPedido(ctx, { pedido: p, empresa, mensagens, eventos, encaminhamentos }) {
  const d = p.dados || {};
  const dados = [
    ['Empresa', empresa ? `${empresa.razao_social} (CNPJ ${empresa.cnpj})` : '—'],
    ['Tomador', d.tomador ? [d.tomador.nome, d.tomador.documento && `(${d.tomador.documento})`].filter(Boolean).join(' ') : '—'],
    ['Serviço', d.descricao || '—'],
    ['Valor', reais(d.valor_centavos) || '—'],
    ['Competência', d.competencia || '—'],
    ['Canal', `${p.canal === 'whatsapp' ? 'WhatsApp' : 'E-mail'} · ${p.remetente}`],
    ['Nota na NFE.io', p.nfeio_invoice_id || '—'],
    ['Motivo', p.motivo || '—'],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('');
  const notas = p.nfeio_invoice_id && ['EMITIDA', 'ENTREGUE'].includes(p.estado)
    ? `<p><a href="/painel/pedidos/${esc(p.id)}/nota.pdf">PDF da nota</a> · <a href="/painel/pedidos/${esc(p.id)}/nota.xml">XML da nota</a></p>` : '';
  const resolver = p.estado === 'ENCAMINHADO' ? `<div class="cartao"><h2 style="margin-top:0">Marcar como resolvido</h2>
      <form method="post" action="/painel/pedidos/${esc(p.id)}/resolver">${csrfCampo(ctx.csrf)}
        <div class="linha">${campo('Número da nota emitida (opcional)', entrada('numero_nota', '', 'maxlength="50"'))}
        ${campo('Observação (opcional)', entrada('observacao', '', 'maxlength="1000"'))}
        <div><button type="submit">Marcar como resolvido</button></div></div>
      </form><p class="suave">Depois de resolvido, novas mensagens do cliente nesta conversa voltam a ser atendidas automaticamente.</p></div>` : '';
  const conversa = mensagens.map((m) => `<p class="${m.direcao}"><span class="suave">${quando(m.criado_em)} · ${m.direcao === 'entrada' ? 'Cliente' : 'Sistema'}</span><br>${esc(m.conteudo)}</p>`).join('');
  const encs = encaminhamentos.map((e) => `<tr><td>${quando(e.criado_em)}</td><td>${esc(e.motivo)}</td><td>${esc(e.para_email || '(ninguém)')}${e.enviado_em ? '' : ' <span class="suave">(envio não confirmado)</span>'}</td>
      <td>${e.resolvido_em ? `${quando(e.resolvido_em)} · ${esc(e.resolvido_por)}${e.numero_nota ? ` · nota ${esc(e.numero_nota)}` : ''}${e.observacao ? `<div class="suave">${esc(e.observacao)}</div>` : ''}` : '—'}</td></tr>`).join('');
  const evs = eventos.map((e) => `<tr><td>${quando(e.criado_em)}</td><td>${esc(e.tipo)}${e.estado_para ? `<div class="suave">${esc(e.estado_de || '')} → ${esc(e.estado_para)}</div>` : ''}</td><td><pre>${esc(JSON.stringify(e.detalhe).slice(0, 600))}</pre></td></tr>`).join('');
  return layout({
    ...ctx,
    titulo: `Pedido ${p.id.slice(0, 8)}`,
    ativo: 'pedidos',
    corpo: `<p><a href="/painel/pedidos">← Pedidos</a></p>
      <h1>Pedido ${esc(p.id.slice(0, 8))} ${estado(p.estado)}</h1>
      ${resolver}
      <div class="cartao"><table>${dados}</table>${notas}</div>
      <h2>Conversa</h2><div class="cartao conversa">${conversa || '<p class="suave">Sem mensagens.</p>'}</div>
      ${encs ? `<h2>Encaminhamentos ao escritório</h2><div class="cartao"><table><thead><tr><th>Quando</th><th>Motivo</th><th>Para</th><th>Resolvido</th></tr></thead><tbody>${encs}</tbody></table></div>` : ''}
      <h2>Eventos</h2><div class="cartao"><table><tbody>${evs}</tbody></table></div>`,
  });
}

function formEmpresa(ctx, e, colaboradores, acao) {
  return `<form method="post" action="${esc(acao)}">${csrfCampo(ctx.csrf)}
    <div class="linha">
      ${campo('CNPJ', entrada('cnpj', e.cnpj, 'required'))}
      ${campo('Razão social', entrada('razao_social', e.razao_social, 'required size="40"'))}
      ${campo('ID da empresa na NFE.io', entrada('nfeio_company_id', e.nfeio_company_id, 'required size="34"'))}
      ${campo('Município (código IBGE)', entrada('municipio_ibge', e.municipio_ibge, 'required maxlength="7" size="8"'))}
    </div>
    <div class="linha">
      ${campo('Valor mínimo (R$)', entrada('valor_minimo', valorReais(e.valor_min_centavos)))}
      ${campo('Valor máximo (R$)', entrada('valor_maximo', valorReais(e.valor_max_centavos), 'required'))}
      ${campo('Colaborador responsável', `<select name="colaborador_id"><option value="">O padrão</option>${opcoes(colaboradores.map((c) => [c.id, `${c.nome} (${c.email})`]), e.colaborador_id)}</select>`)}
    </div>
    <div class="marcas" style="margin-top:12px">${marca('exige_confirmacao', e.exige_confirmacao ?? true, 'O cliente confirma com SIM antes da emissão')}${marca('ativo', e.ativo ?? true, 'Ativa')}</div>
    <p><button type="submit">Salvar empresa</button></p>
  </form>`;
}

function paginaEmpresas(ctx, { empresas, colaboradores, nova }) {
  const linhas = empresas.map((e) => `<tr><td><a href="/painel/empresas/${esc(e.id)}">${esc(e.razao_social)}</a></td><td>${esc(e.cnpj)}</td>
    <td>${reais(e.valor_min_centavos)} a ${reais(e.valor_max_centavos)}</td><td>${e.servicos} serviço(s) · ${e.remetentes} remetente(s)</td>
    <td>${e.ativo ? '' : '<span class="selo">Inativa</span>'}</td></tr>`).join('');
  return layout({
    ...ctx,
    titulo: 'Empresas',
    ativo: 'empresas',
    corpo: `<h1>Empresas</h1>
      <div class="cartao">${empresas.length ? `<table><thead><tr><th>Empresa</th><th>CNPJ</th><th>Faixa de valor</th><th>Cadastro</th><th></th></tr></thead><tbody>${linhas}</tbody></table>` : '<p class="suave">Nenhuma empresa cadastrada.</p>'}</div>
      <h2>Nova empresa</h2><div class="cartao">${formEmpresa(ctx, nova || {}, colaboradores, '/painel/empresas')}</div>`,
  });
}

const RETENCAO = [['pf', 'pessoa física'], ['pj', 'pessoa jurídica'], ['orgao_publico', 'órgão público']];

function formServico(ctx, s, acao) {
  return `<form method="post" action="${esc(acao)}">${csrfCampo(ctx.csrf)}
    <div class="linha">
      ${campo('Apelido (como o cliente chama)', entrada('apelido', s.apelido, 'required'))}
      ${campo('Descrição na nota', entrada('descricao_padrao', s.descricao_padrao, 'required size="36"'))}
      ${campo('Código de serviço municipal', entrada('city_service_code', s.city_service_code, 'required size="10"'))}
      ${campo('Cód. tributação nacional', entrada('federal_service_code', s.federal_service_code, 'size="8"'))}
      ${campo('NBS', entrada('nbs_code', s.nbs_code, 'size="11"'))}
    </div>
    <div class="marcas" style="margin-top:10px"><span class="suave">Pode ter retenção para:</span>
      ${RETENCAO.map(([v, t]) => marca(`retencao_${v}`, (s.pode_ter_retencao || []).includes(v), t)).join('')}
      ${marca('iss_pode_ser_devido_fora', s.iss_pode_ser_devido_fora, 'ISS pode ser devido fora (LC 116, art. 3º)')}
      ${s.id ? marca('ativo', s.ativo ?? true, 'Ativo') : ''}
      <button type="submit" class="secundario">${s.id ? 'Salvar serviço' : 'Adicionar serviço'}</button></div>
  </form>`;
}

function paginaEmpresa(ctx, { empresa, colaboradores, servicos, remetentes, servicoNovo }) {
  const rems = remetentes.map((r) => `<tr><td>${esc(r.canal === 'whatsapp' ? 'WhatsApp' : 'E-mail')}</td><td>${esc(r.identificador)}</td><td>${esc(r.nome || '')}</td>
    <td>${r.ativo ? '' : '<span class="selo">Inativo</span>'}</td>
    <td><form method="post" action="/painel/remetentes/${esc(r.id)}/ativo" class="inline">${csrfCampo(ctx.csrf)}<input type="hidden" name="ativo" value="${r.ativo ? '' : '1'}"><button class="secundario">${r.ativo ? 'Desativar' : 'Reativar'}</button></form></td></tr>`).join('');
  return layout({
    ...ctx,
    titulo: empresa.razao_social || 'Empresa',
    ativo: 'empresas',
    corpo: `<p><a href="/painel/empresas">← Empresas</a></p><h1>${esc(empresa.razao_social)}</h1>
      <div class="cartao">${formEmpresa(ctx, empresa, colaboradores, `/painel/empresas/${empresa.id}`)}</div>
      <h2>Serviços</h2>
      ${servicos.map((s) => `<div class="cartao">${formServico(ctx, s, `/painel/servicos/${s.id}`)}</div>`).join('')}
      <div class="cartao"><p class="suave" style="margin-top:0">Novo serviço</p>${formServico(ctx, servicoNovo || {}, `/painel/empresas/${empresa.id}/servicos`)}</div>
      <h2>Quem pode pedir nota</h2>
      <div class="cartao">${rems ? `<table><thead><tr><th>Canal</th><th>E-mail ou telefone</th><th>Nome</th><th></th><th></th></tr></thead><tbody>${rems}</tbody></table>` : '<p class="suave">Nenhum remetente: ninguém consegue pedir nota para esta empresa.</p>'}
        <form method="post" action="/painel/empresas/${esc(empresa.id)}/remetentes" style="margin-top:12px">${csrfCampo(ctx.csrf)}<div class="linha">
          ${campo('Canal', `<select name="canal">${opcoes([['email', 'E-mail'], ['whatsapp', 'WhatsApp']], 'email')}</select>`)}
          ${campo('E-mail ou telefone com DDD', entrada('identificador', '', 'required'))}
          ${campo('Nome (opcional)', entrada('nome', ''))}
          <div><button type="submit" class="secundario">Adicionar</button></div></div></form>
      </div>`,
  });
}

function paginaColaboradores(ctx, { colaboradores, novo, senhaGerada }) {
  const linha = (c) => `<tr><td colspan="2"><form method="post" action="/painel/colaboradores/${esc(c.id)}">${csrfCampo(ctx.csrf)}<div class="linha">
      ${campo('Nome', entrada('nome', c.nome, 'required'))}
      ${campo('E-mail', `<input value="${esc(c.email)}" disabled>`)}
      ${campo('WhatsApp (opcional)', entrada('whatsapp', c.whatsapp || ''))}
      <div class="marcas">${marca('padrao', c.padrao, 'Padrão')}${marca('ativo', c.ativo, 'Ativo')}</div>
      <div><button type="submit" class="secundario">Salvar</button></div></div></form>
      <form method="post" action="/painel/colaboradores/${esc(c.id)}/senha" class="inline">${csrfCampo(ctx.csrf)}<button class="link suave">${c.tem_senha ? 'Gerar nova senha' : 'Gerar senha de acesso'}</button></form></td></tr>`;
  return layout({
    ...ctx,
    titulo: 'Colaboradores',
    ativo: 'colaboradores',
    aviso: ctx.aviso,
    corpo: `<h1>Colaboradores</h1>
      ${senhaGerada ? `<div class="cartao"><p><b>Senha de ${esc(senhaGerada.email)}:</b> <code style="font-size:16px">${esc(senhaGerada.senha)}</code></p><p class="suave">Ela só aparece agora. Entregue ao colaborador; ele pode trocar em "Minha senha" (clicando no próprio nome).</p></div>` : ''}
      <p class="suave">O padrão recebe os pedidos das empresas sem responsável definido. Cada empresa pode ter um responsável (em Empresas).</p>
      <div class="cartao"><table><tbody>${colaboradores.map(linha).join('')}</tbody></table></div>
      <h2>Novo colaborador</h2>
      <div class="cartao"><form method="post" action="/painel/colaboradores">${csrfCampo(ctx.csrf)}<div class="linha">
        ${campo('Nome', entrada('nome', novo && novo.nome, 'required'))}
        ${campo('E-mail', entrada('email', novo && novo.email, 'type="email" required'))}
        ${campo('WhatsApp (opcional)', entrada('whatsapp', novo && novo.whatsapp))}
        <div class="marcas">${marca('padrao', novo && novo.padrao, 'Padrão')}</div>
        <div><button type="submit">Adicionar</button></div></div></form></div>`,
  });
}

function paginaConfiguracoes(ctx, { cfg, instalacao = { producao: false }, backup = null }) {
  return layout({
    ...ctx,
    titulo: 'Configurações',
    ativo: 'configuracoes',
    corpo: `<h1>Configurações</h1>
      <form method="post" action="/painel/configuracoes">${csrfCampo(ctx.csrf)}
      <div class="cartao">
        <h2 style="margin-top:0">Emissão automática</h2>
        <div class="marcas">${marca('emissao_habilitada', cfg.emissao_habilitada === true, 'Ligada')}</div>
        <p class="suave">Desligada, nenhuma nota é emitida automaticamente: os pedidos prontos vão para o escritório.</p>
      </div>
      <div class="cartao"><h2 style="margin-top:0">Prazos</h2><div class="linha">
        ${campo('Dias úteis para o cliente responder', entrada('prazo_resposta_dias_uteis', cfg.prazo_resposta_dias_uteis, 'type="number" min="1" max="30" required'))}
        ${campo('Perguntas antes de encaminhar', entrada('max_rodadas_perguntas', cfg.max_rodadas_perguntas, 'type="number" min="1" max="10" required'))}
        ${campo('Horas esperando a NFE.io voltar', entrada('prazo_emissor_horas', cfg.prazo_emissor_horas, 'type="number" min="1" max="72" required'))}
      </div></div>
      <div class="cartao"><h2 style="margin-top:0">E-mail</h2>
        <div class="marcas">${marca('email_somente_remetentes_cadastrados', cfg.email_somente_remetentes_cadastrados === true, 'Ignorar e-mails de quem não é remetente cadastrado')}</div>
        <p class="suave">Ligado (caixa compartilhada): newsletter e fornecedor não viram encaminhamento. Desligado (caixa só de pedidos): todo remetente desconhecido vai ao escritório.</p>
      </div>
      <p><button type="submit">Salvar configurações</button></p></form>
      <p class="suave">A confirmação com SIM é por empresa, em Empresas.</p>
      <div class="cartao"><h2 style="margin-top:0">Instalação</h2>
        <p><strong>Notas emitidas:</strong> ${instalacao.producao
          ? `<strong style="color:var(--erro)">reais (produção)</strong>. Liberação: ${esc(instalacao.decisao)}`
          : 'somente de teste (ambiente de desenvolvimento da NFE.io). A emissão real é liberada na instalação, por decisão formal do escritório.'}</p>
        <p><strong>Backup diário:</strong> ${!backup
          ? 'nenhum registrado nesta instalação.'
          : `${backup.atrasado ? '<strong style="color:var(--erro)">atrasado ou com falha.</strong> ' : ''}${backup.bom ? `último que deu certo em ${quando(backup.bom.criado_em)}` : 'nenhum deu certo ainda'}${backup.ultimo.detalhe.ok !== true ? ` · última tentativa falhou em ${quando(backup.ultimo.criado_em)}: ${esc(backup.ultimo.detalhe.erro || 'sem detalhe')}` : ''}.`}</p>
      </div>`,
  });
}

function paginaSenha(ctx) {
  return layout({
    ...ctx,
    titulo: 'Minha senha',
    ativo: 'senha',
    corpo: `<h1>Minha senha</h1><div class="cartao" style="max-width:420px">
      <form method="post" action="/painel/senha">${csrfCampo(ctx.csrf)}
        <label>Senha atual</label><input name="atual" type="password" autocomplete="current-password" required style="width:100%">
        <label>Nova senha (mínimo 10 caracteres)</label><input name="nova" type="password" autocomplete="new-password" minlength="10" required style="width:100%">
        <label>Repita a nova senha</label><input name="repetida" type="password" autocomplete="new-password" minlength="10" required style="width:100%">
        <p><button type="submit">Trocar senha</button></p>
      </form></div>`,
  });
}

const paginaErro = (ctx, status, texto) => layout({ ...ctx, titulo: String(status), corpo: `<h1>${esc(texto)}</h1><p><a href="/painel/pedidos">Voltar aos pedidos</a></p>` });

module.exports = { paginaLogin, paginaPedidos, paginaPedido, paginaEmpresas, paginaEmpresa, paginaColaboradores, paginaConfiguracoes, paginaSenha, paginaErro, ESTADOS };
