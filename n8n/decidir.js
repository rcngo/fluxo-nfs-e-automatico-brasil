// Regras determinísticas do WF3: recebe a extração do Claude + contexto do banco
// e decide o próximo passo. Sem I/O — tudo que depende de rede/banco chega pronto.
// No n8n: colar no nó Code (modo "Run Once for Each Item") e chamar decidir($json).

const PERGUNTAS = {
  tomador_documento: 'o CNPJ ou CPF do tomador (quem vai receber a nota)',
  tomador_documento_invalido: 'o CNPJ/CPF do tomador — o número informado não é válido, pode conferir?',
  tomador_inativo: 'o CNPJ do tomador — ele consta como não ativo na Receita, pode conferir?',
  tomador_nome: 'o nome ou razão social do tomador',
  tomador_endereco: 'o endereço completo do tomador (logradouro, número, bairro, cidade, UF e CEP)',
  servico_id: 'qual serviço foi prestado',
  valor: 'o valor da nota (ex.: R$ 3.500,00)',
  valor_ambiguo: 'o valor exato da nota — ficou ambíguo na mensagem (ex.: R$ 3.500,00)',
  competencia: 'o mês/ano de competência do serviço',
  multiplas_notas: 'por favor, envie um pedido por nota — vamos seguir com a primeira que você mencionou',
};

function soDigitos(s) {
  return (s || '').replace(/\D/g, '');
}

function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12));
  const d2 = calc(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

function cpfValido(c) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (base) => {
    const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * (base.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = calc(c.slice(0, 9));
  const d2 = calc(c.slice(0, 9) + d1);
  return c.endsWith(`${d1}${d2}`);
}

// "Setembro" sem ano: usa o ano corrente, ou o anterior se o mês ainda não chegou.
function resolverCompetencia({ mes, ano }, hoje) {
  if (!mes || mes < 1 || mes > 12) return null;
  const anoFinal = ano || (mes > hoje.getMonth() + 1 ? hoje.getFullYear() - 1 : hoje.getFullYear());
  return `${anoFinal}-${String(mes).padStart(2, '0')}`;
}

function formatarReais(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const TIPOS_TOMADOR = { pf: 'pessoa física', pj: 'pessoa jurídica', orgao_publico: 'órgão público' };

// Natureza jurídica da Receita: o grupo 1 (1xxx) é a administração pública.
const naturezaPublica = (codigo) => /^1\d{3}$/.test(soDigitos(codigo));

// O produto não calcula imposto: quando o cálculo automático da NFE.io pode não bastar,
// o pedido vai para o colaborador. Usa só o que já se sabe; o que falta é perguntado antes.
// Devolve a lista de razões em linguagem simples (vazia = caso comum); o detalhe do
// encaminhamento as junta com "; ", por isso nenhuma razão pode conter "; ".
const citar = (trecho) => (trecho ? ` ("${trecho.replace(/;/g, ',')}")` : '');

function casoTributarioEspecial(x, { doc, docValido, consulta, servico }) {
  const razoes = [];
  if (x.tomador_exterior && x.tomador_exterior.valor) {
    razoes.push(`tomador no exterior${citar(x.tomador_exterior.trecho)}`);
  }
  if (x.valor && x.valor.tipo === 'liquido') {
    razoes.push(`o cliente informou o valor líquido, que quer receber${citar(x.valor.trecho)}, e o valor bruto da nota depende das retenções`);
  }
  if (x.menciona_tributos && x.menciona_tributos.valor) {
    razoes.push(`o cliente fala de imposto ou retenção${citar(x.menciona_tributos.trecho)}`);
  }

  let tipo = null;
  if (docValido && doc.length === 11) tipo = 'pf';
  else if (docValido && consulta && consulta.endereco) {
    if (!consulta.natureza_juridica) {
      razoes.push('não foi possível confirmar na Receita se o tomador é órgão público (natureza jurídica não informada)');
    } else {
      tipo = naturezaPublica(consulta.natureza_juridica) ? 'orgao_publico' : 'pj';
    }
  }
  if (tipo === 'orgao_publico') {
    const desc = consulta.natureza_juridica_descricao ? `${consulta.natureza_juridica_descricao}, ` : '';
    razoes.push(`o tomador é órgão público (${desc}natureza jurídica ${consulta.natureza_juridica} na Receita)`);
  } else if (tipo && servico && (servico.pode_ter_retencao || []).includes(tipo)) {
    razoes.push(`tomador ${TIPOS_TOMADOR[tipo]} e o serviço "${servico.apelido}" está marcado como sujeito a retenção para esse tipo de tomador`);
  }
  if (servico && servico.iss_pode_ser_devido_fora) {
    razoes.push(`o serviço "${servico.apelido}" está entre as exceções da LC 116 (art. 3º): o ISS pode ser devido fora do município da empresa`);
  }
  return razoes;
}

/**
 * @param {object} e  entrada
 * @param {object} e.extracao          JSON do Claude (schemas/extracao.schema.json)
 * @param {string} e.estado_atual      estado do pedido (RECEBIDO, AGUARDANDO_CLIENTE, ...)
 * @param {boolean} e.remetente_autenticado  SPF/DKIM ok (e-mail) ou número cadastrado (WhatsApp)
 * @param {object|null} e.prestador    linha de prestadores (null = remetente sem prestador)
 * @param {object[]} e.servicos        prestador_servicos ativos (com pode_ter_retencao e iss_pode_ser_devido_fora)
 * @param {object|null} e.tomador_consulta  { nome, situacao, endereco, natureza_juridica } vindo do cadastro/BrasilAPI; null se não consultado
 * @param {number} e.duplicados_24h    pedidos emitidos ou em emissão com mesmo tomador e valor nas últimas 24h
 * @param {boolean} e.emissao_habilitada  chave de config
 * @param {string} e.hoje              ISO date
 * @param {number} [e.rodadas_perguntas]  quantas perguntas de dados já foram feitas neste pedido
 * @param {number} [e.max_rodadas]        depois disso, em vez de perguntar de novo, encaminha
 *
 * Retorna { acao, ... }. acao 'encaminhar' leva { motivo, detalhe } — motivo é um código
 * de motor/encaminhamento.js (o pedido vai para o colaborador do escritório).
 */
function decidir(e) {
  const x = e.extracao;
  const hoje = new Date(e.hoje);

  // 1. Bloqueios que não dependem do conteúdo: vão para o colaborador.
  if (!e.remetente_autenticado || !e.prestador) {
    return { acao: 'encaminhar', motivo: 'remetente_nao_autorizado', detalhe: 'remetente não autorizado ou não autenticado' };
  }
  if (!e.prestador.ativo) return { acao: 'encaminhar', motivo: 'empresa_inativa', detalhe: 'empresa inativa no cadastro' };
  if (x.contem_instrucoes_ao_sistema) {
    // Não emite nada automático a partir de uma mensagem suspeita.
    return { acao: 'encaminhar', motivo: 'mensagem_suspeita', detalhe: 'mensagem contém instruções ao sistema' };
  }
  // Cancelar ou substituir uma nota já emitida é com o escritório: emitir outra deixaria duas notas válidas.
  if (x.refere_nota_emitida && x.refere_nota_emitida.valor) {
    return {
      acao: 'encaminhar', motivo: 'nota_ja_emitida',
      detalhe: `o cliente fala de uma nota já emitida${x.refere_nota_emitida.trecho ? ` ("${String(x.refere_nota_emitida.trecho).replace(/;/g, ',')}")` : ''}`,
    };
  }

  // 2. Intenções que não são pedido de nota.
  if (x.intencao === 'cancelar_pedido' || (e.estado_atual === 'AGUARDANDO_CONFIRMACAO' && x.resposta_confirmacao === 'nao')) {
    return { acao: 'cancelar', motivo: 'cliente cancelou' };
  }
  if (e.estado_atual === 'AGUARDANDO_CONFIRMACAO') {
    // Os dados vêm de pedidos.dados, gravados quando o resumo foi enviado.
    if (x.resposta_confirmacao === 'sim') return emitir(e);
    // Resposta diferente de sim/não: reenvia o resumo.
    return { acao: 'reconfirmar' };
  }
  if (x.intencao === 'outro') return { acao: 'ignorar', motivo: 'mensagem não é pedido de nota' };

  // 3. Montagem e validação dos dados.
  const faltantes = [];
  const doc = soDigitos(x.tomador_documento.valor);
  const docValido = doc.length === 14 ? cnpjValido(doc) : doc.length === 11 ? cpfValido(doc) : false;
  if (!doc) faltantes.push('tomador_documento');
  else if (!docValido) {
    faltantes.push('tomador_documento_invalido');
  } else if (doc.length === 14 && e.tomador_consulta && e.tomador_consulta.situacao && e.tomador_consulta.situacao !== 'ATIVA') {
    faltantes.push('tomador_inativo');
  }

  // Razão social oficial (Receita/cadastro) tem prioridade sobre o nome informal da mensagem.
  const nome = (e.tomador_consulta && e.tomador_consulta.nome) || x.tomador_nome.valor;
  if (!nome) faltantes.push('tomador_nome');
  // CNPJ: endereço vem da consulta à Receita. CPF: a NFE.io aceita sem endereço (testado em 23/09/2026).
  if (docValido && doc.length === 14 && !(e.tomador_consulta && e.tomador_consulta.endereco)) faltantes.push('tomador_endereco');

  const servico = e.servicos.find((s) => s.id === x.servico_id.valor);
  if (!servico) faltantes.push('servico_id');

  const centavos = x.valor.centavos;
  if (x.valor.ambiguo) faltantes.push('valor_ambiguo');
  else if (!Number.isInteger(centavos) || centavos <= 0) faltantes.push('valor');

  const competencia = resolverCompetencia(x.competencia, hoje);
  if (!competencia) faltantes.push('competencia');

  if (x.multiplas_notas) faltantes.push('multiplas_notas');

  const dados = {
    prestador_id: e.prestador.id,
    tomador: { documento: doc || null, nome: nome || null, email: x.tomador_email.valor, endereco: e.tomador_consulta && e.tomador_consulta.endereco },
    servico_id: servico ? servico.id : null,
    city_service_code: servico ? servico.city_service_code : null,
    descricao: servico ? [servico.descricao_padrao, x.descricao.valor, competencia && `Competência ${competencia}`].filter(Boolean).join(' — ') : null,
    valor_centavos: Number.isInteger(centavos) ? centavos : null,
    competencia,
  };

  // Caso tributário especial vai para o colaborador assim que é detectado, sem perguntar
  // o resto ao cliente (o colaborador vai precisar falar com ele de qualquer forma).
  const especial = casoTributarioEspecial(x, { doc, docValido, consulta: e.tomador_consulta, servico });
  if (especial.length) {
    return { acao: 'encaminhar', motivo: 'caso_tributario_especial', detalhe: especial.join('; '), faltantes, dados };
  }

  if (faltantes.length) {
    // Já perguntou o bastante: em vez de insistir com o cliente, passa para o escritório.
    if ((e.rodadas_perguntas || 0) >= (e.max_rodadas ?? Infinity)) {
      return { acao: 'encaminhar', motivo: 'dados_incompletos', detalhe: `após ${e.rodadas_perguntas} pergunta(s), ainda falta: ${faltantes.join(', ')}`, faltantes, dados };
    }
    return {
      acao: 'perguntar',
      faltantes,
      dados,
      texto: 'Para emitir a nota, preciso confirmar:\n' + faltantes.map((f) => `• ${PERGUNTAS[f]}`).join('\n'),
    };
  }

  // 4. Regras de negócio bloqueantes.
  if (centavos < e.prestador.valor_min_centavos || centavos > e.prestador.valor_max_centavos) {
    return {
      acao: 'encaminhar', motivo: 'valor_fora_da_faixa', dados,
      detalhe: `valor ${formatarReais(centavos)} fora da faixa cadastrada (${formatarReais(e.prestador.valor_min_centavos)} a ${formatarReais(e.prestador.valor_max_centavos)})`,
    };
  }

  // 5. Duplicidade e confirmação viram pergunta de "SIM".
  const resumo =
    `Confira os dados da nota:\n` +
    `• Tomador: ${nome} (${doc})\n` +
    `• Serviço: ${[servico.descricao_padrao, x.descricao.valor].filter(Boolean).join(' — ')}\n` +
    `• Valor: ${formatarReais(centavos)}\n` +
    `• Competência: ${competencia}\n` +
    `Responda SIM para emitir ou NÃO para cancelar.`;

  if (e.duplicados_24h > 0) {
    return { acao: 'confirmar', dados, texto: 'Já existe uma nota igual, emitida ou em emissão, nas últimas 24h. ' + resumo };
  }
  if (e.prestador.exige_confirmacao) {
    return { acao: 'confirmar', dados, texto: resumo };
  }
  return emitir(e, dados);
}

// Botão de desligar: com a emissão desligada o pedido vai para o colaborador.
function emitir(e, dados) {
  if (!e.emissao_habilitada) return { acao: 'encaminhar', motivo: 'emissao_desligada', dados, detalhe: 'emissão automática desligada na configuração' };
  return { acao: 'emitir', dados };
}

if (typeof module !== 'undefined') {
  module.exports = { decidir, cnpjValido, cpfValido, resolverCompetencia, casoTributarioEspecial, PERGUNTAS };
}
