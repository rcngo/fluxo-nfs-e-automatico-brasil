// Mensagem ao colaborador do escritório quando a aplicação não consegue emitir a nota.
// Puro (sem banco): recebe tudo pronto e devolve assunto e texto.

const { PERGUNTAS } = require('../n8n/decidir');

// Código do motivo → [título curto para o assunto, explicação para o colaborador].
const MOTIVOS = {
  cliente_nao_respondeu: ['cliente não respondeu', 'O cliente não respondeu à pergunta dentro do prazo.'],
  dados_incompletos: ['dados incompletos', 'Depois das perguntas ao cliente, o pedido continua com dados faltando ou inválidos.'],
  remetente_nao_autorizado: ['remetente não autorizado', 'O remetente não está cadastrado para pedir notas, ou o e-mail não passou na autenticação (pode ser falsificação). O cliente não recebeu resposta automática.'],
  empresa_inativa: ['empresa inativa', 'A empresa está marcada como inativa no cadastro.'],
  valor_fora_da_faixa: ['valor fora da faixa', 'O valor está fora da faixa cadastrada para a empresa.'],
  mensagem_suspeita: ['mensagem suspeita', 'A mensagem tenta dar instruções ao sistema (ex.: "ignore as regras"). Confirme o pedido com o cliente por outro meio antes de emitir.'],
  caso_tributario_especial: ['caso tributário especial', 'O imposto desta nota pode não ficar certo com o cálculo automático da NFE.io (retenção, órgão público, valor líquido, ISS devido fora ou tomador no exterior). Confira a tributação e emita manualmente.'],
  nota_ja_emitida: ['cancelamento ou substituição', 'O cliente pede para cancelar, substituir ou refazer uma nota já emitida. Cancelamento e substituição são feitos pelo escritório no painel da NFE.io; nenhuma nota nova foi emitida.'],
  audio_ou_imagem: ['áudio ou imagem', 'O cliente mandou áudio, imagem ou arquivo pelo WhatsApp. A aplicação não lê esse tipo de mensagem: confira o arquivo e atenda o pedido.'],
  falha_leitura: ['falha na leitura', 'A IA não conseguiu ler o pedido.'],
  emissao_desligada: ['emissão desligada', 'A emissão automática está desligada na configuração.'],
  emissor_indisponivel: ['emissor indisponível', 'A NFE.io (ou a prefeitura) ficou fora do ar ou sem concluir a nota durante o prazo de novas tentativas. Confira no painel da NFE.io se a nota foi criada antes de emitir.'],
  erro_emissao: ['erro na emissão', 'A NFE.io não emitiu a nota. Confira no painel da NFE.io se a nota foi criada antes de emitir de novo.'],
  nova_mensagem: ['nova mensagem do cliente', 'O cliente mandou uma nova mensagem num pedido que já está com o escritório. Nada foi feito automaticamente.'],
};

const DESCONHECIDO = ['não consegui emitir', 'A aplicação não conseguiu concluir o pedido.'];

const reais = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const quando = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * @param {object} e
 * @param {string} e.motivo            código de MOTIVOS
 * @param {string} [e.detalhe]         complemento técnico (ex.: mensagem da NFE.io)
 * @param {object} e.pedido            { id, canal, remetente }
 * @param {object|null} e.empresa      { razao_social, cnpj } ou null se não identificada
 * @param {object|null} e.dados        dados já coletados (pedidos.dados)
 * @param {string[]} [e.faltantes]     códigos de PERGUNTAS
 * @param {object[]} e.conversa        [{ direcao, conteudo, criado_em }]
 * @param {string} e.link              link "Resolvido"
 * @param {object} [e.midia]           arquivo recebido pelo WhatsApp ({ descricao, mime, nome }); vai em anexo
 */
function montarEncaminhamento({ motivo, detalhe, pedido, empresa, dados, faltantes = [], conversa, link, midia = null }) {
  const [titulo, explicacao] = MOTIVOS[motivo] || DESCONHECIDO;
  const nomeEmpresa = empresa ? empresa.razao_social : 'remetente sem cadastro';
  const numero = pedido.id.slice(0, 8);
  const assunto = motivo === 'nova_mensagem'
    ? `[NFS-e] Nova mensagem do cliente — ${nomeEmpresa} — pedido ${numero}`
    : `[NFS-e] Não consegui emitir — ${nomeEmpresa} — ${titulo}`;

  const l = [];
  l.push(motivo === 'nova_mensagem' ? 'Chegou uma nova mensagem num pedido que já está com você.' : 'Não consegui emitir esta nota automaticamente.', '');
  l.push(`Motivo: ${explicacao}`);
  if (detalhe && motivo === 'caso_tributario_especial') l.push('Por que é especial:', ...detalhe.split('; ').map((r) => `• ${r}`));
  else if (detalhe) l.push(`Detalhe: ${detalhe}`);
  l.push('');
  l.push(`Empresa: ${empresa ? `${empresa.razao_social} (CNPJ ${empresa.cnpj})` : 'não identificada'}`);
  l.push(`Pedido de: ${pedido.remetente} (${pedido.canal === 'whatsapp' ? 'WhatsApp' : 'e-mail'})`);
  l.push(`Pedido nº: ${numero}`);

  const d = dados || {};
  const coletados = [
    d.tomador && (d.tomador.nome || d.tomador.documento) && `Tomador: ${[d.tomador.nome, d.tomador.documento && `(${d.tomador.documento})`].filter(Boolean).join(' ')}`,
    d.descricao && `Serviço: ${d.descricao}`,
    Number.isInteger(d.valor_centavos) && `Valor: ${reais(d.valor_centavos)}`,
    d.competencia && `Competência: ${d.competencia}`,
  ].filter(Boolean);
  if (coletados.length) l.push('', 'Dados já coletados:', ...coletados.map((c) => `• ${c}`));
  if (midia && midia.id) {
    l.push('', `Arquivo recebido: ${midia.descricao}${midia.nome ? ` "${midia.nome}"` : ''}${midia.mime ? ` (${midia.mime})` : ''}, em anexo.`);
  }
  if (faltantes.length) l.push('', 'O que falta ou está inválido:', ...faltantes.map((f) => `• ${PERGUNTAS[f] || f}`));

  if (conversa.length) {
    l.push('', 'Conversa com o cliente:');
    for (const m of conversa) {
      const quem = m.direcao === 'entrada' ? 'Cliente' : 'Sistema';
      l.push(`[${quando(m.criado_em)}] ${quem}: ${m.conteudo.replace(/\n/g, '\n    ')}`);
    }
  }
  l.push('', `Quando resolver, abra este link para fechar o pedido: ${link}`);
  return { assunto, texto: l.join('\n') };
}

// Alerta do workflow de erro do n8n (falha que não pertence a um pedido específico).
// erro: { workflow, no, mensagem, execucao, url }
function montarAlertaErro(erro, quandoOcorreu) {
  const l = [
    'Um workflow do n8n falhou. Pedidos podem ter ficado sem resposta ou sem envio até isso ser resolvido.',
    '',
    `Workflow: ${erro.workflow || '(desconhecido)'}`,
    `Etapa: ${erro.no || '(desconhecida)'}`,
    `Erro: ${erro.mensagem || '(sem mensagem)'}`,
    `Quando: ${quando(quandoOcorreu)}`,
  ];
  if (erro.url) l.push(`Execução: ${erro.url}`);
  else if (erro.execucao) l.push(`Execução nº ${erro.execucao} (abra no n8n em Executions)`);
  return { assunto: `[NFS-e] Erro no n8n — ${erro.workflow || 'workflow'}`, texto: l.join('\n') };
}

module.exports = { montarEncaminhamento, montarAlertaErro, MOTIVOS };
