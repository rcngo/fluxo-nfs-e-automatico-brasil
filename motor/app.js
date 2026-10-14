// Lógica do motor do fluxo NFS-e: recebe mensagens normalizadas do n8n, extrai com Claude,
// decide com regras determinísticas e emite na NFE.io. Devolve ao n8n o que responder ao cliente
// e, quando não consegue emitir, o que encaminhar ao colaborador do escritório.
//
// Tudo que é externo chega por parâmetro (banco, extrator, NFE.io, consulta de CNPJ, relógio),
// para que os cenários (scripts/cenarios.js) rodem o mesmo código com versões falsas.
// O HTTP fica em server.js.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decidir } = require('../n8n/decidir');
const { remetenteAutenticado, textoNovo, normalizarEmail, ASSUNTO_DO_FLUXO } = require('./email');
const { escolherEmpresa, perguntaEmpresa } = require('./empresa');
const { montarEncaminhamento, montarAlertaErro } = require('./encaminhamento');
const { adicionarDiasUteis } = require('./prazos');
const { assinaturaValida, variantesTelefone, lerWebhook, dentroDaJanela, modeloAtualizacao } = require('./whatsapp');

const RESPOSTAS = {
  encaminhado: 'Não consegui concluir sua nota automaticamente e encaminhei ao escritório, que vai retornar.',
  encaminhado_sem_resposta: 'Como não recebemos resposta, encaminhei seu pedido de nota ao escritório, que vai entrar em contato.',
  em_analise: 'Recebemos sua mensagem. O escritório vai analisar e retornar.',
  cancelado: 'Pedido de nota cancelado. Se precisar, é só enviar um novo pedido.',
  reconfirmar: 'Não entendi a resposta. Responda SIM para emitir a nota ou NÃO para cancelar.',
  midia: 'Não consigo ler áudio, imagem ou arquivo automaticamente. Encaminhei sua mensagem ao escritório, que vai retornar.',
  emissor_instavel: 'O sistema da prefeitura está instável no momento. Sua nota será emitida assim que normalizar, e eu envio aqui.',
};

// Valores usados quando a chave não existe na tabela config.
const CONFIG_PADRAO = {
  emissao_habilitada: false, prazo_resposta_dias_uteis: 2, max_rodadas_perguntas: 2, prazo_emissor_horas: 4, email_somente_remetentes_cadastrados: true,
};

// Espera entre tentativas com a NFE.io fora do ar: 5, 10, 20, 40 e depois 60 minutos.
const esperaEntreTentativas = (n) => Math.min(5 * 2 ** (n - 1), 60) * 60_000;
// Pedido em EMITINDO sem número da NFE.io há mais que isso: o envio foi interrompido.
const ENVIO_INTERROMPIDO_MS = 10 * 60_000;
const horas = (ms) => (ms / 3_600_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.db
 * @param {{ extrair(contexto: object): Promise<object> }} deps.extrator  mesmo retorno de n8n/extrair.js
 * @param {object} deps.nfeio            mesma interface de motor/nfeio.js
 * @param {(cnpj: string) => Promise<object|null>} deps.consultarCnpj
 * @param {{ agora(): Date }} deps.relogio
 * @param {string} deps.pastaDominio     onde copiar o XML para o Domínio
 * @param {(ms: number) => Promise<void>} deps.esperar  pausa entre consultas de status da NFE.io
 * @param {string} deps.urlPublica       endereço do motor visto pelo colaborador (link "Resolvido")
 * @param {{ appSecret?: string, verifyToken?: string }} [deps.whatsapp]  App Secret (assinatura do webhook) e token de verificação
 */
function criarMotor({ db, extrator, nfeio, consultarCnpj, relogio, pastaDominio, esperar, urlPublica, whatsapp = {} }) {
  const agora = () => relogio.agora();
  // Data local, formato AAAA-MM-DD.
  const hojeLocal = () => agora().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

  // -------------------------------------------------------------------------
  // Banco
  // -------------------------------------------------------------------------

  async function lerConfig(c) {
    const { rows } = await c.query('SELECT chave, valor FROM config');
    return { ...CONFIG_PADRAO, ...Object.fromEntries(rows.map((r) => [r.chave, r.valor])) };
  }

  async function evento(c, pedidoId, tipo, detalhe = {}, extra = {}) {
    await c.query(
      `INSERT INTO eventos (pedido_id, tipo, estado_de, estado_para, detalhe, modelo, versao_prompt)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [pedidoId, tipo, extra.de || null, extra.para || null, detalhe, extra.modelo || null, extra.versao_prompt || null],
    );
  }

  async function mudarEstado(c, pedido, para, campos = {}) {
    const sets = ['estado = $2', 'atualizado_em = $3'];
    const vals = [pedido.id, para, agora()];
    for (const [k, v] of Object.entries(campos)) {
      vals.push(k === 'dados' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
      pedido[k] = v;
    }
    await c.query(`UPDATE pedidos SET ${sets.join(', ')} WHERE id = $1`, vals);
    await evento(c, pedido.id, 'estado', campos.motivo ? { motivo: campos.motivo } : {}, { de: pedido.estado, para });
    pedido.estado = para;
  }

  // Esperando o cliente: o prazo conta a partir da última pergunta.
  async function aguardarCliente(c, pedido, estado, campos = {}) {
    const cfg = await lerConfig(c);
    await mudarEstado(c, pedido, estado, { ...campos, expira_em: adicionarDiasUteis(agora(), Number(cfg.prazo_resposta_dias_uteis)) });
  }

  async function registrarSaida(c, pedido, texto) {
    await c.query(
      `INSERT INTO mensagens (pedido_id, direcao, canal, message_id, conteudo, criado_em) VALUES ($1, 'saida', $2, $3, $4, $5)`,
      [pedido.id, pedido.canal, `saida-${crypto.randomUUID()}`, texto, agora()],
    );
  }

  async function responderPara(c, pedidoId) {
    const { rows } = await c.query(
      `SELECT metadados->>'gmail_id' AS gmail_id FROM mensagens
       WHERE pedido_id = $1 AND direcao = 'entrada' ORDER BY criado_em DESC LIMIT 1`,
      [pedidoId],
    );
    return rows[0] && rows[0].gmail_id;
  }

  // responder_para: id da mensagem do Gmail (e-mail) ou número do cliente (WhatsApp).
  // WhatsApp fora da janela de 24 h desde a última mensagem do cliente: só modelo aprovado
  // (o n8n envia `modelo` em vez do texto, e não envia anexos).
  async function resposta(c, pedido, texto, anexos = []) {
    await registrarSaida(c, pedido, texto);
    const r = { responder: true, pedido_id: pedido.id, canal: pedido.canal, texto, anexos };
    if (pedido.canal !== 'whatsapp') return { ...r, responder_para: await responderPara(c, pedido.id) };
    const { rows: [u] } = await c.query(
      `SELECT max(m.criado_em) AS em FROM mensagens m JOIN pedidos p ON p.id = m.pedido_id
       WHERE p.canal = 'whatsapp' AND p.conversa_ref = $1 AND m.direcao = 'entrada'`,
      [pedido.conversa_ref],
    );
    const dentro = dentroDaJanela(u && u.em, agora());
    return { ...r, responder_para: pedido.conversa_ref.replace(/^\+/, ''), dentro_da_janela: dentro, modelo: dentro ? null : modeloAtualizacao(texto) };
  }

  // -------------------------------------------------------------------------
  // Encaminhamento ao colaborador
  // -------------------------------------------------------------------------

  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

  // Grava a mensagem para o colaborador (responsável pela empresa, ou o padrão) e devolve
  // o que o n8n deve enviar. Não muda o estado do pedido.
  // midia: arquivo recebido pelo WhatsApp ({ tipo, descricao, id, mime, nome }); o n8n baixa e anexa.
  async function registrarEncaminhamento(c, pedido, motivo, { detalhe = null, faltantes = [], empresa = null, midia = null } = {}) {
    const { rows: [emp] } = pedido.prestador_id
      ? await c.query('SELECT * FROM prestadores WHERE id = $1', [pedido.prestador_id])
      : { rows: [empresa] };
    const { rows: [colab] } = await c.query(
      `SELECT * FROM colaboradores WHERE ativo AND (id = $1 OR padrao) ORDER BY (id = $1) DESC NULLS LAST LIMIT 1`,
      [emp ? emp.colaborador_id : null],
    );
    const { rows: conversa } = await c.query(
      'SELECT direcao, conteudo, criado_em FROM mensagens WHERE pedido_id = $1 ORDER BY criado_em',
      [pedido.id],
    );
    const token = crypto.randomBytes(24).toString('base64url');
    const link = `${urlPublica}/resolvido?t=${token}`;
    const { assunto, texto } = montarEncaminhamento({
      motivo, detalhe, pedido, empresa: emp || null, dados: pedido.dados, faltantes, conversa, link, midia,
    });
    const { rows: [enc] } = await c.query(
      `INSERT INTO encaminhamentos (pedido_id, motivo, detalhe, colaborador_id, para_email, para_whatsapp, assunto, texto, token_hash, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [pedido.id, motivo, detalhe, colab ? colab.id : null, colab ? colab.email : null, colab ? colab.whatsapp : null, assunto, texto, hashToken(token), agora()],
    );
    await evento(c, pedido.id, 'encaminhamento', { motivo, para: colab ? colab.email : null });
    if (!colab) await evento(c, pedido.id, 'erro', { etapa: 'encaminhamento', motivo: 'nenhum colaborador cadastrado (nem padrão)' });
    return {
      encaminhamento_id: enc.id,
      motivo,
      para_email: colab ? colab.email : null,
      para_whatsapp: colab ? colab.whatsapp : null,
      colaborador: colab ? colab.nome : null,
      assunto,
      texto,
      link,
      midia: midia && midia.id ? midia : null,
    };
  }

  // Passa o pedido para o colaborador e avisa o cliente.
  // cliente: 'padrao' | 'sem_resposta' | 'generica' | 'midia' | 'nenhuma'
  async function encaminhar(c, pedido, motivo, { detalhe, faltantes, empresa, midia, cliente = 'padrao' } = {}) {
    await mudarEstado(c, pedido, 'ENCAMINHADO', { motivo: detalhe ? `${motivo} — ${detalhe}` : motivo });
    const enc = await registrarEncaminhamento(c, pedido, motivo, { detalhe, faltantes, empresa, midia });
    const textoCliente = {
      padrao: RESPOSTAS.encaminhado, sem_resposta: RESPOSTAS.encaminhado_sem_resposta, generica: RESPOSTAS.em_analise, midia: RESPOSTAS.midia,
    }[cliente];
    if (!textoCliente) return { responder: false, pedido_id: pedido.id, motivo, encaminhar: enc };
    return { ...(await resposta(c, pedido, textoCliente)), encaminhar: enc };
  }

  // -------------------------------------------------------------------------
  // Emissão
  // -------------------------------------------------------------------------

  // A referência do pedido (pedidos.id) vai como externalId: depois de uma falha de rede,
  // é por ela que se descobre se a nota foi criada, antes de qualquer nova tentativa.
  async function emitirPedido(c, pedido, prestador, dados) {
    const { rows: servicos } = await c.query('SELECT * FROM prestador_servicos WHERE id = $1', [dados.servico_id]);
    const payload = nfeio.montarPayload(dados, servicos[0], pedido.id);

    // Trava contra emissão dupla: só um processo passa daqui por pedido.
    const { rowCount } = await c.query(
      `UPDATE pedidos SET estado = 'EMITINDO', dados = $2, atualizado_em = $3, proxima_tentativa_em = NULL
       WHERE id = $1 AND nfeio_invoice_id IS NULL AND estado <> 'EMITINDO' AND NOT emissao_incerta`,
      [pedido.id, JSON.stringify(dados), agora()],
    );
    if (!rowCount) return { responder: false, motivo: 'emissão já em andamento' };
    await evento(c, pedido.id, 'emissao', { payload }, { de: pedido.estado, para: 'EMITINDO' });
    pedido.estado = 'EMITINDO';
    pedido.dados = dados;

    let nota;
    try {
      nota = await nfeio.emitir(prestador.nfeio_company_id, payload);
    } catch (e) {
      return falhaNoEnvio(c, pedido, e);
    }
    return acompanharNota(c, pedido, prestador, nota);
  }

  async function falhaNoEnvio(c, pedido, e) {
    if (e.tipo === 'rejeitada') return encaminhar(c, pedido, 'erro_emissao', { detalhe: `a NFE.io recusou o envio: ${e.message}` });
    if (e.tipo === 'bloqueada') return encaminhar(c, pedido, 'erro_emissao', { detalhe: `envio bloqueado antes de chegar à NFE.io: ${e.message}` });
    // Indisponível: nada foi enviado. Qualquer outra falha (incerta ou desconhecida): o envio
    // pode ter chegado, e a próxima tentativa começa consultando pela referência.
    return aguardarEmissor(c, pedido, { incerta: e.tipo !== 'indisponivel', detalhe: e.message });
  }

  // NFE.io fora do ar: espera a próxima tentativa (retomar). O cliente é avisado uma vez só.
  async function aguardarEmissor(c, pedido, { incerta, detalhe }) {
    const primeira = !pedido.emissor_desde;
    const tentativas = pedido.emissor_tentativas + 1;
    await evento(c, pedido.id, 'erro', { etapa: 'emissao', motivo: detalhe, tentativa: tentativas, incerta });
    await mudarEstado(c, pedido, 'AGUARDANDO_EMISSOR', {
      emissor_desde: pedido.emissor_desde || agora(),
      emissor_tentativas: tentativas,
      proxima_tentativa_em: new Date(agora().getTime() + esperaEntreTentativas(tentativas)),
      emissao_incerta: pedido.emissao_incerta || incerta,
      motivo: detalhe,
    });
    if (!primeira) return { responder: false, pedido_id: pedido.id, motivo: 'aguardando a NFE.io' };
    return resposta(c, pedido, RESPOSTAS.emissor_instavel);
  }

  // Nota criada na NFE.io (pelo envio ou achada pela referência): grava o id e espera concluir.
  async function acompanharNota(c, pedido, prestador, nota) {
    await c.query('UPDATE pedidos SET nfeio_invoice_id = $2, emissao_incerta = false WHERE id = $1', [pedido.id, nota.id]);
    pedido.nfeio_invoice_id = nota.id;
    pedido.emissao_incerta = false;
    await evento(c, pedido.id, 'emissao', { invoice_id: nota.id, flowStatus: nota.flowStatus });

    // O ambiente de testes conclui em segundos; se demorar, retomar() termina o serviço.
    try {
      for (let i = 0; i < 20 && !nfeio.concluida(nota); i++) {
        await esperar(3000);
        nota = await nfeio.status(prestador.nfeio_company_id, nota.id);
      }
    } catch (e) {
      await evento(c, pedido.id, 'erro', { etapa: 'status', motivo: e.message });
      return { responder: false, pedido_id: pedido.id, motivo: 'aguardando NFE.io' };
    }
    if (!nfeio.concluida(nota)) return { responder: false, pedido_id: pedido.id, motivo: 'aguardando NFE.io' };
    return await finalizarEmissao(c, pedido, prestador, nota);
  }

  async function finalizarEmissao(c, pedido, prestador, nota) {
    if (nota.flowStatus !== 'Issued') {
      return encaminhar(c, pedido, 'erro_emissao', { detalhe: `NFE.io: ${nota.flowStatus} ${nota.flowMessage || ''} (nota ${nota.id})`.trim() });
    }
    let pdf;
    let xml;
    try {
      pdf = await nfeio.baixar(prestador.nfeio_company_id, nota.id, 'pdf');
      xml = await nfeio.baixar(prestador.nfeio_company_id, nota.id, 'xml');
    } catch (e) {
      // Continua EMITINDO: retomar() tenta baixar de novo.
      await evento(c, pedido.id, 'erro', { etapa: 'download', motivo: e.message });
      return { responder: false, pedido_id: pedido.id, motivo: 'nota emitida, aguardando PDF/XML da NFE.io' };
    }
    fs.mkdirSync(pastaDominio, { recursive: true });
    fs.writeFileSync(path.join(pastaDominio, `${nota.id}.xml`), xml);
    await mudarEstado(c, pedido, 'EMITIDA');
    await evento(c, pedido.id, 'emissao', { numero: nota.number, codigo_verificacao: nota.checkCode });

    const d = pedido.dados;
    const valor = (d.valor_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const texto =
      `Nota emitida: nº ${nota.number} para ${d.tomador.nome}, no valor de ${valor} (competência ${d.competencia}).\n` +
      'Seguem o PDF e o XML em anexo.';
    return resposta(c, pedido, texto, [
      { campo: 'nota_pdf', nome: `NFS-e ${nota.number}.pdf`, mime: 'application/pdf', base64: pdf.toString('base64') },
      { campo: 'nota_xml', nome: `NFS-e ${nota.number}.xml`, mime: 'application/xml', base64: xml.toString('base64') },
    ]);
  }

  // -------------------------------------------------------------------------
  // Processamento de uma mensagem recebida
  // -------------------------------------------------------------------------

  // Tomador cadastrado (planilha ou consulta anterior) ou, para CNPJ, consulta à Receita.
  // CPF: só o cadastro (não há consulta pública); sem cadastro, vale o nome da mensagem.
  async function obterTomador(c, prestadorId, doc) {
    if (!doc || (doc.length !== 14 && doc.length !== 11)) return null;
    const { rows: [t] } = await c.query(
      'SELECT nome, situacao_cadastral, endereco, natureza_juridica FROM tomadores WHERE prestador_id = $1 AND documento = $2',
      [prestadorId, doc],
    );
    if (doc.length === 11) return t ? { nome: t.nome, situacao: null, endereco: t.endereco } : null;
    // CNPJ cadastrado pela planilha (ou consultado antes da E3) vem sem endereço, situação ou
    // natureza jurídica: completa pela Receita.
    if (t && t.endereco && t.situacao_cadastral && t.natureza_juridica) {
      return { nome: t.nome, situacao: t.situacao_cadastral, endereco: t.endereco, natureza_juridica: t.natureza_juridica };
    }
    const consulta = await consultarCnpj(doc);
    if (consulta && consulta.nome) {
      await c.query(
        `INSERT INTO tomadores (prestador_id, documento, nome, endereco, situacao_cadastral, natureza_juridica, consultado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (prestador_id, documento) DO UPDATE
           SET nome = EXCLUDED.nome, endereco = EXCLUDED.endereco, situacao_cadastral = EXCLUDED.situacao_cadastral,
               natureza_juridica = EXCLUDED.natureza_juridica, consultado_em = EXCLUDED.consultado_em`,
        [prestadorId, doc, consulta.nome, consulta.endereco, consulta.situacao, consulta.natureza_juridica || null, agora()],
      );
    }
    // Receita fora do ar, mas o tomador já tinha sido consultado: vale o cadastro (sem natureza
    // jurídica, decidir() encaminha em vez de presumir que não é órgão público).
    if (!consulta && t && t.endereco && t.situacao_cadastral) {
      return { nome: t.nome, situacao: t.situacao_cadastral, endereco: t.endereco, natureza_juridica: t.natureza_juridica };
    }
    return consulta;
  }

  async function processar(msg) {
    const c = await db.connect();
    try {
      // Mensagens da mesma conversa são processadas uma de cada vez.
      await c.query('SELECT pg_advisory_lock(hashtext($1))', [`${msg.canal}:${msg.conversa_ref}`]);

      // E-mail que não é para o fluxo: ignorado sem gravar nada (fica na caixa do escritório).
      const remetente = (msg.remetente || '').toLowerCase();
      if (msg.canal === 'email') {
        if (ASSUNTO_DO_FLUXO.test(msg.assunto || '')) return { responder: false, ignorado: true, motivo: 'mensagem do próprio fluxo' };
        const cfg = await lerConfig(c);
        if (cfg.email_somente_remetentes_cadastrados === true) {
          const { rowCount } = await c.query(
            `SELECT 1 FROM prestador_remetentes WHERE canal = 'email' AND identificador = $1 AND ativo LIMIT 1`,
            [remetente],
          );
          if (!rowCount) return { responder: false, ignorado: true, motivo: 'remetente não cadastrado' };
        }
      }

      const texto = textoNovo(msg.texto, msg.assunto);
      const ins = await c.query(
        `INSERT INTO mensagens (direcao, canal, message_id, conteudo, metadados, criado_em)
         VALUES ('entrada', $1, $2, $3, $4, $5) ON CONFLICT (canal, message_id) DO NOTHING RETURNING id`,
        [msg.canal, msg.message_id, texto, {
          gmail_id: msg.gmail_id, remetente: msg.remetente, assunto: msg.assunto, auth_results: msg.auth_results, nome_perfil: msg.nome_perfil, midia: msg.midia,
        }, agora()],
      );
      if (!ins.rowCount) return { responder: false, motivo: 'mensagem já processada' };

      let { rows: [pedido] } = await c.query(
        `SELECT * FROM pedidos WHERE canal = $1 AND conversa_ref = $2
         AND estado IN ('RECEBIDO','AGUARDANDO_CLIENTE','AGUARDANDO_CONFIRMACAO','VALIDADO','EMITINDO','AGUARDANDO_EMISSOR')`,
        [msg.canal, msg.conversa_ref],
      );

      // Conversa com pedido já encaminhado e ainda não resolvido: a mensagem vai para o
      // colaborador e nada é feito automaticamente (evita emitir em paralelo com o escritório).
      if (!pedido) {
        const { rows: [encaminhado] } = await c.query(
          `SELECT * FROM pedidos WHERE canal = $1 AND conversa_ref = $2 AND estado = 'ENCAMINHADO' ORDER BY criado_em DESC LIMIT 1`,
          [msg.canal, msg.conversa_ref],
        );
        if (encaminhado) {
          await c.query('UPDATE mensagens SET pedido_id = $1 WHERE id = $2', [encaminhado.id, ins.rows[0].id]);
          const enc = await registrarEncaminhamento(c, encaminhado, 'nova_mensagem', { midia: msg.midia });
          return { responder: false, pedido_id: encaminhado.id, motivo: 'pedido já está com o escritório', encaminhar: enc };
        }
      }

      const novo = !pedido;
      if (novo) {
        const t = agora();
        ({ rows: [pedido] } = await c.query(
          `INSERT INTO pedidos (canal, remetente, conversa_ref, criado_em, atualizado_em)
           VALUES ($1, $2, $3, $4, $4) RETURNING *`,
          [msg.canal, remetente, msg.conversa_ref, t],
        ));
        await evento(c, pedido.id, 'estado', {}, { para: 'RECEBIDO' });
      }
      await c.query('UPDATE mensagens SET pedido_id = $1 WHERE id = $2', [pedido.id, ins.rows[0].id]);

      // Nota em emissão ou esperando a NFE.io voltar: nada em paralelo (a tarefa periódica conclui).
      if (pedido.estado === 'EMITINDO') return { responder: false, pedido_id: pedido.id, motivo: 'nota em emissão' };
      if (pedido.estado === 'AGUARDANDO_EMISSOR') return { responder: false, pedido_id: pedido.id, motivo: 'nota aguardando a NFE.io' };

      const { rows: prestadores } = await c.query(
        `SELECT p.* FROM prestadores p JOIN prestador_remetentes r ON r.prestador_id = p.id
         WHERE r.canal = $1 AND r.identificador = ANY($2) AND r.ativo`,
        // WhatsApp: o número pode chegar sem o 9 do celular.
        [msg.canal, msg.canal === 'whatsapp' ? variantesTelefone(remetente) : [remetente]],
      );
      const autenticado = msg.canal === 'email' ? remetenteAutenticado(msg.auth_results, remetente) : true;
      await evento(c, pedido.id, 'validacao', { remetente, autenticado, prestadores: prestadores.length });

      if (!prestadores.length || !autenticado) {
        // Sem resposta ao remetente (evita confirmar a existência do fluxo para quem não é
        // cliente, ou responder a um e-mail falsificado); o colaborador decide.
        const detalhe = !prestadores.length ? `remetente ${remetente} não cadastrado` : `e-mail de ${remetente} sem autenticação SPF/DKIM`;
        return await encaminhar(c, pedido, 'remetente_nao_autorizado', {
          detalhe, cliente: 'nenhuma', empresa: prestadores.length === 1 ? prestadores[0] : null,
        });
      }

      // Áudio, imagem ou arquivo: a IA não lê; o colaborador recebe o arquivo.
      if (msg.midia) {
        return await encaminhar(c, pedido, 'audio_ou_imagem', {
          detalhe: `o cliente mandou ${msg.midia.descricao}`, faltantes: pedido.faltantes, midia: msg.midia, cliente: 'midia',
          empresa: prestadores.length === 1 ? prestadores[0] : null,
        });
      }

      const { rows: historico } = await c.query(
        `SELECT direcao, conteudo, criado_em FROM mensagens WHERE pedido_id = $1 ORDER BY criado_em`,
        [pedido.id],
      );

      // Empresa do pedido: já escolhida antes, a única do remetente, ou escolhida pela conversa.
      let prestador = prestadores.find((p) => p.id === pedido.prestador_id) || null;
      if (!prestador) {
        const escolha = prestadores.length === 1 ? { prestador: prestadores[0], como: 'unica' } : escolherEmpresa(prestadores, historico);
        if (!escolha) {
          await evento(c, pedido.id, 'validacao', { empresa: 'ambigua', candidatas: prestadores.map((p) => p.cnpj) });
          await aguardarCliente(c, pedido, 'AGUARDANDO_CLIENTE');
          return await resposta(c, pedido, perguntaEmpresa(prestadores));
        }
        prestador = escolha.prestador;
        await c.query('UPDATE pedidos SET prestador_id = $2 WHERE id = $1', [pedido.id, prestador.id]);
        pedido.prestador_id = prestador.id;
        await evento(c, pedido.id, 'validacao', { empresa: prestador.cnpj, como: escolha.como });
      }

      const { rows: servicos } = await c.query('SELECT * FROM prestador_servicos WHERE prestador_id = $1 AND ativo', [prestador.id]);

      const r = await extrator.extrair({
        hoje: hojeLocal(),
        canal: msg.canal,
        prestador,
        servicos,
        dadosJaColetados: null, // a conversa inteira vai no prompt; o Claude consolida
        mensagens: historico.map((m) => ({ direcao: m.direcao, data: m.criado_em.toISOString(), conteudo: m.conteudo })),
      });
      if (!r.ok) {
        await evento(c, pedido.id, 'erro', { etapa: 'extracao', motivo: r.motivo });
        return await encaminhar(c, pedido, 'falha_leitura', { detalhe: r.motivo });
      }
      await evento(c, pedido.id, 'extracao', { extracao: r.extracao, usage: r.usage }, { modelo: r.modelo, versao_prompt: r.versao_prompt });

      const x = r.extracao;
      const doc = (x.tomador_documento.valor || '').replace(/\D/g, '');
      const tomador = await obterTomador(c, prestador.id, doc);
      const { rows: [dup] } = await c.query(
        `SELECT count(*)::int AS n FROM pedidos WHERE prestador_id = $1 AND tomador_documento = $2
         AND valor_centavos = $3 AND estado IN ('EMITIDA','ENTREGUE','EMITINDO','AGUARDANDO_EMISSOR') AND criado_em > $4::timestamptz - interval '24 hours'`,
        [prestador.id, doc, x.valor.centavos, agora()],
      );
      const cfg = await lerConfig(c);

      // Nova informação enquanto aguarda o SIM: recalcula e manda um resumo novo.
      const corrigindo = pedido.estado === 'AGUARDANDO_CONFIRMACAO' && !x.resposta_confirmacao && ['complemento', 'pedido_nota'].includes(x.intencao);
      const decisao = decidir({
        extracao: x,
        estado_atual: corrigindo ? 'AGUARDANDO_CLIENTE' : pedido.estado,
        remetente_autenticado: autenticado,
        prestador,
        servicos,
        tomador_consulta: tomador,
        duplicados_24h: dup.n,
        emissao_habilitada: cfg.emissao_habilitada === true,
        hoje: hojeLocal(),
        rodadas_perguntas: pedido.rodadas_perguntas,
        max_rodadas: Number(cfg.max_rodadas_perguntas),
      });
      await evento(c, pedido.id, 'decisao', decisao);

      const dados = decisao.dados || pedido.dados;
      if (decisao.dados) {
        await c.query(
          `UPDATE pedidos SET dados = $2, faltantes = $3, valor_centavos = $4, tomador_documento = $5 WHERE id = $1`,
          [pedido.id, JSON.stringify(decisao.dados), decisao.faltantes || [], decisao.dados.valor_centavos, decisao.dados.tomador.documento],
        );
        pedido.dados = decisao.dados;
      }

      switch (decisao.acao) {
        case 'perguntar':
          await aguardarCliente(c, pedido, 'AGUARDANDO_CLIENTE', { rodadas_perguntas: pedido.rodadas_perguntas + 1 });
          return await resposta(c, pedido, decisao.texto);
        case 'confirmar':
          await aguardarCliente(c, pedido, 'AGUARDANDO_CONFIRMACAO');
          return await resposta(c, pedido, decisao.texto);
        case 'reconfirmar':
          return await resposta(c, pedido, RESPOSTAS.reconfirmar);
        case 'emitir':
          return await emitirPedido(c, pedido, prestador, dados);
        case 'encaminhar':
          return await encaminhar(c, pedido, decisao.motivo, {
            detalhe: decisao.detalhe,
            faltantes: decisao.faltantes,
            // Mensagem suspeita: resposta genérica, sem explicar o que foi detectado.
            cliente: decisao.motivo === 'mensagem_suspeita' ? 'generica' : 'padrao',
          });
        case 'cancelar':
          await mudarEstado(c, pedido, 'CANCELADO', { motivo: decisao.motivo });
          return await resposta(c, pedido, RESPOSTAS.cancelado);
        case 'ignorar':
        default:
          // Assunto que não é nota: fica para o atendimento normal do escritório.
          if (novo) await mudarEstado(c, pedido, 'CANCELADO', { motivo: 'mensagem não é pedido de nota' });
          return { responder: false, pedido_id: pedido.id, motivo: decisao.motivo };
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock_all()').catch(() => {});
      c.release();
    }
  }

  // -------------------------------------------------------------------------
  // Tarefas periódicas
  // -------------------------------------------------------------------------

  // canal: só os pedidos desse canal (cada workflow do n8n envia pelo seu canal); sem canal, todos.
  async function retomar({ canal = null } = {}) {
    const c = await db.connect();
    const respostas = [];
    // Um pedido com problema não impede os outros.
    const cada = async (pedido, fn) => {
      try {
        respostas.push(await fn());
      } catch (e) {
        await evento(c, pedido.id, 'erro', { etapa: 'retomar', motivo: e.message }).catch(() => {});
      }
    };
    try {
      const t = agora();
      const cfg = await lerConfig(c);
      const prazoMs = Number(cfg.prazo_emissor_horas) * 3_600_000;

      // Notas enviadas à NFE.io que ainda não concluíram.
      const { rows: emitindo } = await c.query(
        `SELECT p.*, pr.nfeio_company_id FROM pedidos p JOIN prestadores pr ON pr.id = p.prestador_id
         WHERE p.estado = 'EMITINDO' AND p.nfeio_invoice_id IS NOT NULL AND p.atualizado_em < $1::timestamptz - interval '1 minute'
           AND ($2::text IS NULL OR p.canal = $2)`,
        [t, canal],
      );
      for (const pedido of emitindo) {
        await cada(pedido, async () => {
          const prestador = { nfeio_company_id: pedido.nfeio_company_id };
          let nota = null;
          try {
            nota = await nfeio.status(prestador.nfeio_company_id, pedido.nfeio_invoice_id);
          } catch (e) {
            await evento(c, pedido.id, 'erro', { etapa: 'status', motivo: e.message });
          }
          if (nota && nfeio.concluida(nota)) return finalizarEmissao(c, pedido, prestador, nota);
          const parado = t - new Date(pedido.atualizado_em);
          if (parado < prazoMs) return { responder: false };
          return encaminhar(c, pedido, 'emissor_indisponivel', {
            detalhe: `nota ${pedido.nfeio_invoice_id} ainda em processamento na NFE.io depois de ${horas(parado)} h${nota ? ` (${nota.flowStatus})` : ''}; confira se ela foi emitida antes de emitir outra`,
          });
        });
      }

      // Envio interrompido (o motor parou entre marcar EMITINDO e receber o número da nota):
      // não se sabe se a nota foi criada.
      const { rows: interrompidos } = await c.query(
        `SELECT * FROM pedidos WHERE estado = 'EMITINDO' AND nfeio_invoice_id IS NULL AND atualizado_em < $1 AND ($2::text IS NULL OR canal = $2)`,
        [new Date(t.getTime() - ENVIO_INTERROMPIDO_MS), canal],
      );
      for (const pedido of interrompidos) {
        await cada(pedido, () => aguardarEmissor(c, pedido, { incerta: true, detalhe: 'envio à NFE.io interrompido' }));
      }

      // NFE.io estava fora do ar: nova tentativa, consultando pela referência se o envio anterior pode ter chegado.
      const { rows: esperando } = await c.query(
        `SELECT p.*, pr.nfeio_company_id FROM pedidos p JOIN prestadores pr ON pr.id = p.prestador_id
         WHERE p.estado = 'AGUARDANDO_EMISSOR' AND p.proxima_tentativa_em <= $1 AND ($2::text IS NULL OR p.canal = $2)`,
        [t, canal],
      );
      for (const pedido of esperando) await cada(pedido, () => tentarDeNovo(c, pedido, cfg, prazoMs));

      // Cliente não respondeu no prazo: vai para o colaborador.
      const { rows: vencidos } = await c.query(
        `SELECT * FROM pedidos WHERE estado IN ('AGUARDANDO_CLIENTE','AGUARDANDO_CONFIRMACAO') AND expira_em < $1 AND ($2::text IS NULL OR canal = $2)`,
        [t, canal],
      );
      for (const pedido of vencidos) {
        const detalhe = pedido.estado === 'AGUARDANDO_CONFIRMACAO' ? 'sem resposta ao pedido de confirmação (SIM/NÃO)' : 'sem resposta à pergunta';
        await cada(pedido, () => encaminhar(c, pedido, 'cliente_nao_respondeu', { detalhe, faltantes: pedido.faltantes, cliente: 'sem_resposta' }));
      }
    } finally {
      c.release();
    }
    return respostas.filter((r) => r.responder || r.encaminhar);
  }

  async function tentarDeNovo(c, pedido, cfg, prazoMs) {
    const prestador = { nfeio_company_id: pedido.nfeio_company_id };
    const esperando = agora() - new Date(pedido.emissor_desde);
    const vencido = esperando >= prazoMs;
    const incertaAntes = pedido.emissao_incerta;
    const encaminharIndisponivel = () => encaminhar(c, pedido, 'emissor_indisponivel', {
      detalhe: `${pedido.emissor_tentativas} tentativa(s) em ${horas(esperando)} h; última falha: ${pedido.motivo}` +
        (pedido.emissao_incerta ? '. Um dos envios pode ter chegado à NFE.io: não se sabe se a nota foi criada' : ''),
    });

    if (pedido.emissao_incerta) {
      let notas;
      try {
        notas = await nfeio.consultarPorReferencia(prestador.nfeio_company_id, pedido.id);
      } catch (e) {
        if (vencido) return encaminharIndisponivel();
        return aguardarEmissor(c, pedido, { incerta: true, detalhe: `consulta pela referência do pedido falhou: ${e.message}` });
      }
      await evento(c, pedido.id, 'emissao', { consulta_referencia: notas.map((n) => n.id) });
      if (notas.length > 1) {
        return encaminhar(c, pedido, 'erro_emissao', { detalhe: `a NFE.io tem ${notas.length} notas com a referência deste pedido (${notas.map((n) => n.id).join(', ')}); cancele as que sobrarem` });
      }
      if (notas.length === 1) {
        // A nota foi criada no envio anterior: segue com ela, sem enviar de novo.
        await mudarEstado(c, pedido, 'EMITINDO');
        return acompanharNota(c, pedido, prestador, notas[0]);
      }
      await c.query('UPDATE pedidos SET emissao_incerta = false WHERE id = $1', [pedido.id]);
      pedido.emissao_incerta = false;
    }
    if (vencido) return encaminharIndisponivel();
    if (cfg.emissao_habilitada !== true) {
      return encaminhar(c, pedido, 'emissao_desligada', {
        detalhe: 'emissão desligada enquanto o pedido esperava a NFE.io voltar' + (incertaAntes ? ' (a consulta confirmou que a nota não foi criada)' : ''),
      });
    }
    return emitirPedido(c, pedido, prestador, pedido.dados);
  }

  // Webhook da Cloud API do WhatsApp (o n8n repassa o corpo bruto e o X-Hub-Signature-256).
  // Assinatura inválida: recusado sem gravar nada. Válida: as mensagens normalizadas, que o n8n
  // manda uma a uma para /processar (depois de responder 200 à Meta).
  async function receberWhatsApp({ corpo, assinatura }) {
    if (!assinaturaValida(corpo, assinatura, whatsapp.appSecret)) return { valido: false, mensagens: [] };
    let payload;
    try {
      payload = JSON.parse(corpo);
    } catch {
      return { valido: true, mensagens: [] };
    }
    const { mensagens, falhas_envio: falhas } = lerWebhook(payload);
    for (const f of falhas) await evento(db, null, 'erro', { origem: 'whatsapp', etapa: 'envio', ...f });
    return { valido: true, mensagens };
  }

  // Verificação do webhook na configuração da Meta (GET com hub.mode, hub.verify_token, hub.challenge).
  function verificarWebhookWhatsApp({ modo, token, desafio }) {
    const ok = modo === 'subscribe' && Boolean(whatsapp.verifyToken) && token === whatsapp.verifyToken;
    return { ok, desafio: ok ? String(desafio || '') : null };
  }

  // E-mail como o gatilho do Gmail do n8n entrega (motor/email.js).
  const processarEmail = (item) => processar(normalizarEmail(item));

  // O n8n enviou a mensagem ao colaborador.
  async function encaminhamentoEnviado({ encaminhamento_id }) {
    const { rows: [e] } = await db.query(
      'UPDATE encaminhamentos SET enviado_em = $2 WHERE id = $1 AND enviado_em IS NULL RETURNING pedido_id, para_email',
      [encaminhamento_id, agora()],
    );
    if (e) await evento(db, e.pedido_id, 'encaminhamento', { enviado: true, para: e.para_email });
    return { ok: Boolean(e) };
  }

  // Workflow de erro do n8n: registra e devolve o alerta para o colaborador padrão.
  async function erroN8n(erro) {
    await evento(db, null, 'erro', { origem: 'n8n', ...erro });
    const { rows: [colab] } = await db.query('SELECT nome, email FROM colaboradores WHERE ativo AND padrao LIMIT 1');
    return { para_email: colab ? colab.email : null, ...montarAlertaErro(erro, agora()) };
  }

  async function entregue({ pedido_id }) {
    const c = await db.connect();
    try {
      const { rows: [pedido] } = await c.query(`SELECT * FROM pedidos WHERE id = $1 AND estado = 'EMITIDA'`, [pedido_id]);
      if (pedido) await mudarEstado(c, pedido, 'ENTREGUE');
      return { ok: Boolean(pedido) };
    } finally {
      c.release();
    }
  }

  // -------------------------------------------------------------------------
  // Link "Resolvido" (o colaborador fecha o pedido encaminhado)
  // -------------------------------------------------------------------------

  async function consultarEncaminhamento(token) {
    const { rows: [e] } = await db.query(
      `SELECT e.*, p.estado, p.remetente, pr.razao_social FROM encaminhamentos e
       JOIN pedidos p ON p.id = e.pedido_id LEFT JOIN prestadores pr ON pr.id = p.prestador_id
       WHERE e.token_hash = $1`,
      [hashToken(String(token || ''))],
    );
    if (!e) return { status: 'invalido' };
    return {
      status: e.estado === 'RESOLVIDO_MANUAL' ? 'ja_resolvido' : 'pendente',
      pedido_id: e.pedido_id,
      assunto: e.assunto,
      empresa: e.razao_social,
      remetente: e.remetente,
    };
  }

  async function resolverEncaminhamento(token, { numero_nota = null, observacao = null } = {}) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const { rows: [e] } = await c.query('SELECT * FROM encaminhamentos WHERE token_hash = $1 FOR UPDATE', [hashToken(String(token || ''))]);
      if (!e) {
        await c.query('ROLLBACK');
        return { status: 'invalido' };
      }
      const { rows: [pedido] } = await c.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [e.pedido_id]);
      if (pedido.estado === 'RESOLVIDO_MANUAL') {
        await c.query('ROLLBACK');
        const { rows: [r] } = await db.query('SELECT max(resolvido_em) AS em FROM encaminhamentos WHERE pedido_id = $1', [pedido.id]);
        return { status: 'ja_resolvido', resolvido_em: r.em };
      }
      await fecharPedido(c, pedido, `link enviado a ${e.para_email || '(sem destinatário)'}`, { numero_nota, observacao });
      await c.query('COMMIT');
      return { status: 'resolvido', pedido_id: pedido.id };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async function fecharPedido(c, pedido, quem, { numero_nota = null, observacao = null } = {}) {
    await c.query(
      `UPDATE encaminhamentos SET resolvido_em = $2, resolvido_por = $3, numero_nota = $4, observacao = $5 WHERE pedido_id = $1 AND resolvido_em IS NULL`,
      [pedido.id, agora(), quem, numero_nota || null, observacao || null],
    );
    await mudarEstado(c, pedido, 'RESOLVIDO_MANUAL', { motivo: `resolvido pelo colaborador (${quem})${numero_nota ? ` — nota ${numero_nota}` : ''}` });
  }

  // Painel: o colaborador marca como resolvido um pedido encaminhado. quem: e-mail de quem clicou.
  async function resolverPedido(pedidoId, { quem, numero_nota = null, observacao = null }) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const { rows: [pedido] } = await c.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
      if (!pedido || pedido.estado !== 'ENCAMINHADO') {
        await c.query('ROLLBACK');
        return { status: !pedido ? 'invalido' : pedido.estado === 'RESOLVIDO_MANUAL' ? 'ja_resolvido' : 'nao_encaminhado' };
      }
      await fecharPedido(c, pedido, `painel: ${quem}`, { numero_nota, observacao });
      await c.query('COMMIT');
      return { status: 'resolvido', pedido_id: pedido.id };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  return { processar, processarEmail, receberWhatsApp, verificarWebhookWhatsApp, retomar, entregue, encaminhamentoEnviado, erroN8n, consultarEncaminhamento, resolverEncaminhamento, resolverPedido };
}

module.exports = { criarMotor, RESPOSTAS };
