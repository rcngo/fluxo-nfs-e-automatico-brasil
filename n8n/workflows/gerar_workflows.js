// Gera os workflows do n8n (importar com n8n import:workflow):
//   NFS - E-mail     (nfs_email.json)
//   NFS - WhatsApp   (nfs_whatsapp.json), só com --whatsapp-cred e --whatsapp-numero
//   NFS - Erros      (nfs_erros.json), workflow de erro dos dois
//
// Uso:
//   node n8n/workflows/gerar_workflows.js --gmail <id credencial Gmail> [--alerta <email reserva>]
//        [--whatsapp-cred <id credencial Header Auth "Authorization: Bearer <token>">]
//        [--whatsapp-numero <Phone number ID da Cloud API>] [--saida <pasta>]
//
// --saida: onde gravar os .json (padrão: esta pasta). Na instalação, infra/producao/workflows.sh usa.
// --alerta: quem recebe o alerta de erro quando nem o motor responde (normalmente o alerta vai
// ao colaborador padrão cadastrado no motor).
//
// Os workflows só transportam mensagens: toda regra fica no motor.

const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map((a) => a.split(/\s+/)));
const credId = args.gmail;
const alertaReserva = args.alerta || '';
if (!credId) throw new Error('informe --gmail <id da credencial Gmail>');
const gmailCred = { gmailOAuth2: { id: credId, name: 'Gmail account' } };
const MOTOR = 'http://motor:3000';
const ID_ERROS = 'NfsErrosPoc00001';

const motor = (nome, rota, corpo, pos, extra = {}) => ({
  name: nome,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: pos,
  parameters: {
    method: 'POST',
    url: `${MOTOR}${rota}`,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: corpo,
    options: { timeout: 180000 },
  },
  ...extra,
});

const seVerdadeiro = (nome, expr, operador, direita, pos) => ({
  name: nome,
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: pos,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: nome, leftValue: expr, rightValue: direita, operator: operador }],
      combinator: 'and',
    },
    options: {},
  },
});

const codigo = (nome, jsCode, pos, porItem = false) => ({
  name: nome,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: pos,
  parameters: { ...(porItem ? { mode: 'runOnceForEachItem' } : {}), jsCode },
});

const gmailResponder = (nome, comAnexos, pos) => ({
  name: nome,
  type: 'n8n-nodes-base.gmail',
  typeVersion: 2.1,
  position: pos,
  credentials: gmailCred,
  parameters: {
    resource: 'message',
    operation: 'reply',
    messageId: '={{ $json.responder_para }}',
    emailType: 'text',
    message: '={{ $json.texto }}',
    options: {
      appendAttribution: false,
      replyToSenderOnly: true,
      ...(comAnexos ? { attachmentsUi: { attachmentsBinary: [{ property: 'nota_pdf,nota_xml' }] } } : {}),
    },
  },
});

const gmailEnviar = (nome, para, assunto, texto, pos) => ({
  name: nome,
  type: 'n8n-nodes-base.gmail',
  typeVersion: 2.1,
  position: pos,
  credentials: gmailCred,
  parameters: {
    resource: 'message',
    operation: 'send',
    sendTo: para,
    subject: assunto,
    emailType: 'text',
    message: texto,
    options: { appendAttribution: false },
  },
});

function ligar(ligacoes) {
  const connections = {};
  for (const [de, para, saida = 0] of ligacoes) {
    connections[de] = connections[de] || { main: [] };
    while (connections[de].main.length <= saida) connections[de].main.push([]);
    connections[de].main[saida].push({ node: para, type: 'main', index: 0 });
  }
  return connections;
}

const workflow = (id, name, nodes, ligacoes, settings = {}) => ({
  id, // fixo: reimportar substitui o mesmo workflow
  name,
  nodes: nodes.map((n, i) => ({ id: `node-${i}`, ...n })),
  connections: ligar(ligacoes),
  settings: { executionOrder: 'v1', ...settings },
  active: false,
});

// Peças compartilhadas com o workflow do WhatsApp (n8n/workflows/whatsapp.js).
function pecas() {
  return { motor, seVerdadeiro, codigo, gmailEnviar, gmailCred, workflow, ID_ERROS };
}

// ---------------------------------------------------------------------------
// NFS - E-mail
// ---------------------------------------------------------------------------

const email = workflow('NfsEmailPoc00001', 'NFS - E-mail', [
  {
    name: 'Gmail: novo e-mail',
    type: 'n8n-nodes-base.gmailTrigger',
    typeVersion: 1.2,
    position: [0, 0],
    credentials: gmailCred,
    parameters: {
      pollTimes: { item: [{ mode: 'everyMinute' }] },
      simple: false,
      // Só a caixa de entrada, sem o que a própria caixa envia (respostas, encaminhamentos,
      // alertas) e sem respostas às notificações do fluxo. Remetente não cadastrado: o motor ignora.
      filters: { q: 'in:inbox -from:me -subject:"[NFS-e]"' },
      options: {},
    },
  },
  // O gatilho guarda só o último cabeçalho de cada nome; o Authentication-Results que vale é o
  // do topo (gravado pelo Gmail). A API em format=metadata devolve todos, na ordem.
  {
    name: 'Gmail: autenticação',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [240, 0],
    credentials: gmailCred,
    parameters: {
      method: 'GET',
      url: '=https://gmail.googleapis.com/gmail/v1/users/me/messages/{{ $json.id }}',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'gmailOAuth2',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'format', value: 'metadata' }, { name: 'metadataHeaders', value: 'Authentication-Results' }] },
      options: {},
    },
  },
  codigo('Montar e-mail', `const email = $('Gmail: novo e-mail').item.json;
const cabecalhos = ($json.payload && $json.payload.headers) || [];
return {
  json: {
    ...email,
    autenticacao: cabecalhos.filter((h) => h.name.toLowerCase() === 'authentication-results').map((h) => h.value),
  },
};`, [480, 0], true),
  motor('Motor: e-mail', '/email', '={{ JSON.stringify($json) }}', [720, 0]),
  {
    name: 'A cada 2 minutos',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 300],
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 2 }] } },
  },
  motor('Motor: retomar pendentes', '/retomar', '{"canal":"email"}', [720, 300]),
  // Primeiro avisa o colaborador; só depois responde ao cliente ("encaminhei ao escritório").
  seVerdadeiro('Encaminhar?', '={{ !!($json.encaminhar && $json.encaminhar.para_email) }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [960, 150]),
  gmailEnviar('Gmail: enviar ao colaborador', '={{ $json.encaminhar.para_email }}', '={{ $json.encaminhar.assunto }}', '={{ $json.encaminhar.texto }}', [1200, 0]),
  motor('Motor: encaminhamento enviado', '/encaminhado', `={{ JSON.stringify({ encaminhamento_id: $('Encaminhar?').item.json.encaminhar.encaminhamento_id }) }}`, [1440, 0]),
  codigo('Seguir com a resposta', `return { json: $('Encaminhar?').item.json };`, [1680, 0], true),
  seVerdadeiro('Responder?', '={{ $json.responder }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [1920, 150]),
  seVerdadeiro('Tem anexos?', '={{ ($json.anexos || []).length }}', { type: 'number', operation: 'gt' }, 0, [2160, 150]),
  codigo('Preparar anexos', `const saida = [];
for (const i of $input.all()) {
  const binary = {};
  for (const a of i.json.anexos) {
    binary[a.campo] = { data: a.base64, mimeType: a.mime, fileName: a.nome };
  }
  const { anexos, ...json } = i.json;
  saida.push({ json, binary });
}
return saida;`, [2400, 0]),
  gmailResponder('Gmail: responder com a nota', true, [2640, 0]),
  motor('Motor: marcar entregue', '/entregue', `={{ JSON.stringify({ pedido_id: $('Preparar anexos').item.json.pedido_id }) }}`, [2880, 0]),
  gmailResponder('Gmail: responder', false, [2400, 300]),
], [
  ['Gmail: novo e-mail', 'Gmail: autenticação'],
  ['Gmail: autenticação', 'Montar e-mail'],
  ['Montar e-mail', 'Motor: e-mail'],
  ['Motor: e-mail', 'Encaminhar?'],
  ['A cada 2 minutos', 'Motor: retomar pendentes'],
  ['Motor: retomar pendentes', 'Encaminhar?'],
  ['Encaminhar?', 'Gmail: enviar ao colaborador', 0],
  ['Encaminhar?', 'Responder?', 1],
  ['Gmail: enviar ao colaborador', 'Motor: encaminhamento enviado'],
  ['Motor: encaminhamento enviado', 'Seguir com a resposta'],
  ['Seguir com a resposta', 'Responder?'],
  ['Responder?', 'Tem anexos?'],
  ['Tem anexos?', 'Preparar anexos', 0],
  ['Tem anexos?', 'Gmail: responder', 1],
  ['Preparar anexos', 'Gmail: responder com a nota'],
  ['Gmail: responder com a nota', 'Motor: marcar entregue'],
], { errorWorkflow: ID_ERROS });

// ---------------------------------------------------------------------------
// NFS - Erros (workflow de erro do "NFS - E-mail")
// ---------------------------------------------------------------------------

const erros = workflow(ID_ERROS, 'NFS - Erros', [
  { name: 'Erro em workflow', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
  // Falha no gatilho (ex.: autorização do Gmail expirada) vem em `trigger`, não em `execution`.
  codigo('Resumir erro', `const e = $json.execution || {};
const t = $json.trigger || {};
const erro = e.error || t.error || {};
return {
  json: {
    workflow: ($json.workflow && $json.workflow.name) || '',
    no: e.lastNodeExecuted || (erro.node && erro.node.name) || (t.error ? 'gatilho' : ''),
    mensagem: erro.message || erro.description || '',
    execucao: e.id || null,
    url: e.url || null,
  },
};`, [240, 0], true),
  motor('Motor: registrar erro', '/erro-n8n', '={{ JSON.stringify($json) }}', [480, 0], { onError: 'continueRegularOutput' }),
  // Se nem o motor respondeu, o alerta vai para o e-mail reserva com o resumo do n8n.
  codigo('Montar alerta', `const resumo = $('Resumir erro').item.json;
const reserva = ${JSON.stringify(alertaReserva)};
if ($json.para_email && $json.assunto) return { json: $json };
if (!reserva) return [];
return {
  json: {
    para_email: reserva,
    assunto: '[NFS-e] Erro no n8n — ' + (resumo.workflow || 'workflow') + ' (motor sem resposta)',
    texto: 'Um workflow do n8n falhou e o motor também não respondeu.\\n\\n' +
      'Workflow: ' + resumo.workflow + '\\nEtapa: ' + resumo.no + '\\nErro: ' + resumo.mensagem +
      (resumo.url ? '\\nExecução: ' + resumo.url : ''),
  },
};`, [720, 0], true),
  gmailEnviar('Gmail: alerta', '={{ $json.para_email }}', '={{ $json.assunto }}', '={{ $json.texto }}', [960, 0]),
], [
  ['Erro em workflow', 'Resumir erro'],
  ['Resumir erro', 'Motor: registrar erro'],
  ['Motor: registrar erro', 'Montar alerta'],
  ['Montar alerta', 'Gmail: alerta'],
]);

const saidas = [['nfs_email.json', email], ['nfs_erros.json', erros]];
if (args['whatsapp-cred'] && args['whatsapp-numero']) saidas.push(['nfs_whatsapp.json', require('./whatsapp').workflowWhatsApp({ ...pecas(), waCredId: args['whatsapp-cred'], numeroId: args['whatsapp-numero'] })]);
if (args.saida) fs.mkdirSync(args.saida, { recursive: true });
for (const [arquivo, wf] of saidas) {
  const saida = path.join(args.saida || __dirname, arquivo);
  fs.writeFileSync(saida, JSON.stringify(wf, null, 2));
  console.log(saida);
}
