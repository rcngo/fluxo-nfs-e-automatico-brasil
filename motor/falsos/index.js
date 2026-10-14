// Versões falsas das dependências externas do motor, para os cenários e testes.
// Nenhuma delas acessa a rede.

const nfeioReal = require('../nfeio');

const { ErroNfeio } = nfeioReal;

// Relógio controlável. Cada leitura avança 1 segundo, para que mensagens gravadas na mesma
// chamada fiquem em ordem (o relógio real já se comporta assim na prática).
function relogioFalso(inicio) {
  let t = new Date(inicio).getTime();
  return {
    agora: () => new Date((t += 1000)),
    avancar: (ms) => { t += ms; },
  };
}

// NFE.io falsa. Usa o montarPayload real (o payload enviado é o mesmo da produção)
// e registra cada nota criada para os cenários conferirem.
//
// modos: um modo, ou uma lista com o comportamento de cada envio (o último se repete):
//   sucesso          nota emitida
//   rejeita          a NFE.io cria a nota e ela falha (IssueFailed)
//   demora           a nota fica em processamento até concluirPendentes()
//   indisponivel     fora do ar: nada é enviado
//   falha_envio      a conexão cai no envio e a nota NÃO foi criada (o motor não sabe disso)
//   falha_apos_criar a conexão cai depois que a nota foi criada (o motor não sabe disso)
// opcoes.consulta: 'fora' → a consulta pela referência (externalId) também não responde.
function nfeioFalsa(modos = 'sucesso', opcoes = {}) {
  const fila = Array.isArray(modos) ? [...modos] : [modos];
  const emissoes = [];
  const notas = new Map();
  const proximoModo = () => (fila.length > 1 ? fila.shift() : fila[0]);

  function criar(companyId, payload, modo) {
    emissoes.push({ companyId, payload });
    const id = `nota-falsa-${emissoes.length}`;
    const nota = {
      id,
      externalId: payload.externalId,
      number: 1000 + emissoes.length,
      checkCode: `CV${emissoes.length}`,
      flowStatus: modo === 'rejeita' ? 'IssueFailed' : modo === 'demora' ? 'WaitingSend' : 'Issued',
      flowMessage: modo === 'rejeita' ? 'Código de serviço inválido para o município (simulado)' : undefined,
    };
    notas.set(id, nota);
    return nota;
  }

  return {
    emissoes,
    montarPayload: nfeioReal.montarPayload,
    concluida: nfeioReal.concluida,
    async emitir(companyId, payload) {
      const modo = proximoModo();
      if (modo === 'indisponivel') throw new ErroNfeio('indisponivel', 'NFE.io sem resposta (ECONNREFUSED, simulado)');
      if (modo === 'falha_envio') throw new ErroNfeio('incerta', 'NFE.io sem resposta (ECONNRESET, simulado)');
      const nota = criar(companyId, payload, modo);
      if (modo === 'falha_apos_criar') throw new ErroNfeio('incerta', 'NFE.io sem resposta (TimeoutError, simulado)');
      return { ...nota };
    },
    async status(companyId, id) {
      return { ...notas.get(id) };
    },
    async consultarPorReferencia(companyId, referencia) {
      if (opcoes.consulta === 'fora') throw new ErroNfeio('indisponivel', 'NFE.io consulta por referência HTTP 503 (simulado)');
      return [...notas.values()].filter((n) => n.externalId === referencia).map((n) => ({ ...n }));
    },
    // Para cenários de demora: a nota "termina" de emitir.
    concluirPendentes() {
      for (const n of notas.values()) if (n.flowStatus.startsWith('Waiting')) n.flowStatus = 'Issued';
    },
    async baixar(companyId, id, formato) {
      return Buffer.from(formato === 'xml' ? `<Nfse><Id>${id}</Id></Nfse>` : `%PDF-falso ${id}`);
    },
  };
}

// Consulta de CNPJ falsa: tabela fixa; CNPJ fora da tabela = não encontrado.
function brasilapiFalsa(tabela = {}) {
  return async (cnpj) => tabela[cnpj] || { nome: null, situacao: 'NAO_ENCONTRADO', endereco: null };
}

module.exports = { relogioFalso, nfeioFalsa, brasilapiFalsa, ...require('./extrator') };
