// Workflow "NFS - WhatsApp" (Cloud API oficial da Meta). Gerado por gerar_workflows.js.
//
// Recebe:  POST /webhook/whatsapp → motor confere a assinatura (X-Hub-Signature-256) → 200 ou 403
//          → cada mensagem vai ao motor (/processar).
//          GET  /webhook/whatsapp  → verificação do webhook na configuração da Meta.
// Envia:   colaborador por e-mail (com o áudio/imagem em anexo, se houver) antes de responder;
//          cliente por texto, ou pelo modelo aprovado fora da janela de 24 h; nota em PDF e XML
//          como documentos.
// A cada 2 minutos: /retomar do canal whatsapp.

const GRAPH = 'https://graph.facebook.com/v25.0';

function workflowWhatsApp({ motor, seVerdadeiro, codigo, gmailEnviar, gmailCred, workflow, ID_ERROS, waCredId, numeroId }) {
  const waCred = { httpHeaderAuth: { id: waCredId, name: 'WhatsApp Cloud API' } };
  const graph = (nome, metodo, url, pos, extra = {}) => ({
    name: nome,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    credentials: waCred,
    parameters: { method: metodo, url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {}, ...extra },
  });
  const enviarMensagem = (nome, corpo, pos) => graph(nome, 'POST', `${GRAPH}/${numeroId}/messages`, pos, {
    sendBody: true, specifyBody: 'json', jsonBody: corpo,
  });
  const webhook = (nome, metodo, pos, opcoes = {}) => ({
    name: nome,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: pos,
    webhookId: `nfs-whatsapp-${metodo.toLowerCase()}`,
    parameters: { httpMethod: metodo, path: 'whatsapp', responseMode: 'responseNode', options: opcoes },
  });
  // O arquivo baixado da Meta (binário "arquivo") vai em anexo ao colaborador.
  const comAnexo = (no) => ({
    ...no,
    parameters: { ...no.parameters, options: { ...no.parameters.options, attachmentsUi: { attachmentsBinary: [{ property: 'arquivo' }] } } },
  });
  const responder = (nome, codigoHttp, corpo, pos) => ({
    name: nome,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: pos,
    parameters: { respondWith: 'text', responseBody: corpo, options: { responseCode: codigoHttp } },
  });

  return workflow('NfsWhatsAppPoc01', 'NFS - WhatsApp', [
    // Verificação (configuração do webhook na Meta).
    webhook('WhatsApp: verificação', 'GET', [0, -300]),
    motor('Motor: verificar webhook', '/whatsapp/verificacao',
      `={{ JSON.stringify({ modo: $json.query['hub.mode'], token: $json.query['hub.verify_token'], desafio: $json.query['hub.challenge'] }) }}`, [240, -300]),
    responder('Responder verificação', '={{ $json.ok ? 200 : 403 }}', '={{ $json.desafio || "" }}', [480, -300]),

    // Mensagens recebidas: o corpo bruto vai ao motor, que confere a assinatura.
    webhook('WhatsApp: mensagem', 'POST', [0, 0], { rawBody: true }),
    codigo('Corpo bruto', `const saida = [];
for (let i = 0; i < $input.all().length; i++) {
  const corpo = (await this.helpers.getBinaryDataBuffer(i, 'data')).toString('utf8');
  const cab = $input.all()[i].json.headers || {};
  saida.push({ json: { corpo, assinatura: cab['x-hub-signature-256'] || '' } });
}
return saida;`, [240, 0]),
    motor('Motor: conferir webhook', '/whatsapp/webhook', '={{ JSON.stringify($json) }}', [480, 0]),
    // A Meta espera 200 logo; o processamento (IA, emissão) continua depois da resposta.
    responder('Responder à Meta', '={{ $json.valido ? 200 : 403 }}', '', [720, 0]),
    codigo('Separar mensagens', `return $input.all().flatMap((i) => (i.json.mensagens || []).map((m) => ({ json: m })));`, [960, 0]),
    motor('Motor: processar', '/processar', '={{ JSON.stringify($json) }}', [1200, 0]),

    {
      name: 'A cada 2 minutos',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [960, 300],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 2 }] } },
    },
    motor('Motor: retomar pendentes', '/retomar', '{"canal":"whatsapp"}', [1200, 300]),

    // Colaborador primeiro (com o arquivo do cliente em anexo, se houver); depois o cliente.
    seVerdadeiro('Encaminhar?', '={{ !!($json.encaminhar && $json.encaminhar.para_email) }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [1440, 150]),
    seVerdadeiro('Tem arquivo do cliente?', '={{ !!$json.encaminhar.midia }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [1680, 0]),
    graph('WhatsApp: endereço do arquivo', 'GET', `={{ "${GRAPH}/" + $json.encaminhar.midia.id }}`, [1920, -150]),
    graph('WhatsApp: baixar arquivo', 'GET', '={{ $json.url }}', [2160, -150], {
      options: { response: { response: { responseFormat: 'file', outputPropertyName: 'arquivo' } } },
    }),
    comAnexo(gmailEnviar('Gmail: colaborador com arquivo', `={{ $('Encaminhar?').item.json.encaminhar.para_email }}`,
      `={{ $('Encaminhar?').item.json.encaminhar.assunto }}`, `={{ $('Encaminhar?').item.json.encaminhar.texto }}`, [2400, -150])),
    gmailEnviar('Gmail: colaborador', '={{ $json.encaminhar.para_email }}', '={{ $json.encaminhar.assunto }}', '={{ $json.encaminhar.texto }}', [1920, 150]),
    motor('Motor: encaminhamento enviado', '/encaminhado', `={{ JSON.stringify({ encaminhamento_id: $('Encaminhar?').item.json.encaminhar.encaminhamento_id }) }}`, [2640, 0]),
    codigo('Seguir com a resposta', `return { json: $('Encaminhar?').item.json };`, [2880, 0], true),

    seVerdadeiro('Responder?', '={{ $json.responder }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [3120, 150]),
    seVerdadeiro('Fora da janela de 24 h?', '={{ !!$json.modelo }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [3360, 150]),
    enviarMensagem('WhatsApp: modelo', `={{ JSON.stringify({
  messaging_product: 'whatsapp', recipient_type: 'individual', to: $json.responder_para, type: 'template',
  template: { name: $json.modelo.nome, language: { code: $json.modelo.idioma },
    components: [{ type: 'body', parameters: $json.modelo.parametros.map((t) => ({ type: 'text', text: t })) }] },
}) }}`, [3600, 0]),
    enviarMensagem('WhatsApp: texto', `={{ JSON.stringify({
  messaging_product: 'whatsapp', recipient_type: 'individual', to: $json.responder_para, type: 'text',
  text: { body: $json.texto, preview_url: false },
}) }}`, [3600, 300]),
    codigo('Retomar item', `return { json: $('Fora da janela de 24 h?').item.json };`, [3840, 300], true),
    seVerdadeiro('Tem anexos?', '={{ ($json.anexos || []).length }}', { type: 'number', operation: 'gt' }, 0, [4080, 300]),
    // Um item por arquivo (PDF e XML), com o binário em "arquivo".
    codigo('Preparar documentos', `const saida = [];
for (const i of $input.all()) {
  for (const a of i.json.anexos) {
    saida.push({
      json: { para: i.json.responder_para, pedido_id: i.json.pedido_id, nome: a.nome, mime: a.mime },
      binary: { arquivo: { data: a.base64, mimeType: a.mime, fileName: a.nome } },
    });
  }
}
return saida;`, [4320, 300]),
    graph('WhatsApp: enviar arquivo', 'POST', `${GRAPH}/${numeroId}/media`, [4560, 300], {
      sendBody: true,
      contentType: 'multipart-form-data',
      bodyParameters: { parameters: [
        { name: 'messaging_product', value: 'whatsapp' },
        { name: 'type', value: '={{ $json.mime }}' },
        { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'arquivo' },
      ] },
    }),
    enviarMensagem('WhatsApp: documento', `={{ JSON.stringify({
  messaging_product: 'whatsapp', recipient_type: 'individual', to: $('Preparar documentos').item.json.para, type: 'document',
  document: { id: $json.id, filename: $('Preparar documentos').item.json.nome },
}) }}`, [4800, 300]),
    motor('Motor: marcar entregue', '/entregue', `={{ JSON.stringify({ pedido_id: $('Preparar documentos').item.json.pedido_id }) }}`, [5040, 300]),
  ], [
    ['WhatsApp: verificação', 'Motor: verificar webhook'],
    ['Motor: verificar webhook', 'Responder verificação'],
    ['WhatsApp: mensagem', 'Corpo bruto'],
    ['Corpo bruto', 'Motor: conferir webhook'],
    ['Motor: conferir webhook', 'Responder à Meta'],
    ['Responder à Meta', 'Separar mensagens'],
    ['Separar mensagens', 'Motor: processar'],
    ['Motor: processar', 'Encaminhar?'],
    ['A cada 2 minutos', 'Motor: retomar pendentes'],
    ['Motor: retomar pendentes', 'Encaminhar?'],
    ['Encaminhar?', 'Tem arquivo do cliente?', 0],
    ['Encaminhar?', 'Responder?', 1],
    ['Tem arquivo do cliente?', 'WhatsApp: endereço do arquivo', 0],
    ['Tem arquivo do cliente?', 'Gmail: colaborador', 1],
    ['WhatsApp: endereço do arquivo', 'WhatsApp: baixar arquivo'],
    ['WhatsApp: baixar arquivo', 'Gmail: colaborador com arquivo'],
    ['Gmail: colaborador com arquivo', 'Motor: encaminhamento enviado'],
    ['Gmail: colaborador', 'Motor: encaminhamento enviado'],
    ['Motor: encaminhamento enviado', 'Seguir com a resposta'],
    ['Seguir com a resposta', 'Responder?'],
    ['Responder?', 'Fora da janela de 24 h?'],
    ['Fora da janela de 24 h?', 'WhatsApp: modelo', 0],
    ['Fora da janela de 24 h?', 'WhatsApp: texto', 1],
    ['WhatsApp: texto', 'Retomar item'],
    ['Retomar item', 'Tem anexos?'],
    ['Tem anexos?', 'Preparar documentos', 0],
    ['Preparar documentos', 'WhatsApp: enviar arquivo'],
    ['WhatsApp: enviar arquivo', 'WhatsApp: documento'],
    ['WhatsApp: documento', 'Motor: marcar entregue'],
  ], { errorWorkflow: ID_ERROS });
}

module.exports = { workflowWhatsApp };
