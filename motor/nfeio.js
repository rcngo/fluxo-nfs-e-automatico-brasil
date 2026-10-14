// Cliente NFE.io com trava de ambiente: só emite se a empresa estiver inteiramente em Development
// (sem inscrição estadual, que desviaria para o padrão nacional). Production só é aceito com a
// decisão formal do escritório registrada na instalação (producaoLiberada, abaixo).

const API_V1 = 'https://api.nfe.io/v1/companies';
const API_V2 = 'https://api.nfse.io/v2/companies';

// Falha da NFE.io, classificada para o motor decidir o que fazer:
//   rejeitada    a NFE.io recusou o pedido (4xx): não adianta repetir → colaborador
//   bloqueada    a trava de ambiente (ou a configuração da empresa) impediu o envio → colaborador
//   indisponivel nada foi enviado (fora do ar, 429, falha antes do POST) → tentar de novo depois
//   incerta      o POST pode ter chegado (conexão caiu, timeout, 5xx) → consultar pela referência
//                antes de qualquer nova tentativa
class ErroNfeio extends Error {
  constructor(tipo, mensagem) {
    super(mensagem);
    this.tipo = tipo;
  }
}

// Erros de conexão em que a requisição certamente não saiu da máquina.
const SEM_CONEXAO = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'];

function erroDeRede(e, enviando) {
  const codigo = (e.cause && e.cause.code) || e.code || e.name;
  const naoSaiu = SEM_CONEXAO.includes(codigo);
  return new ErroNfeio(enviando && !naoSaiu ? 'incerta' : 'indisponivel', `NFE.io sem resposta (${codigo || e.message})`);
}

async function chamar(metodo, url, corpo, bruto = false) {
  let r;
  try {
    r = await fetch(url, {
      method: metodo,
      headers: { Authorization: process.env.NFEIO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw erroDeRede(e, metodo === 'POST');
  }
  if (bruto) return { status: r.status, dados: Buffer.from(await r.arrayBuffer()) };
  const texto = await r.text();
  let dados = texto;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* mantém texto */ }
  return { status: r.status, dados };
}

// Nota real (Production) exige as duas variáveis na instalação do escritório (infra/producao/.env):
//   EMISSAO_PRODUCAO_HABILITADA=true
//   EMISSAO_PRODUCAO_DECISAO=<referência da decisão formal: documento, data, quem assinou>
// Sem a referência, a liberação não vale (motor/server.js nem sobe).
function producaoLiberada() {
  return process.env.EMISSAO_PRODUCAO_HABILITADA === 'true' && Boolean((process.env.EMISSAO_PRODUCAO_DECISAO || '').trim());
}

async function travaAmbiente(companyId) {
  const empresa = await chamar('GET', `${API_V2}/${companyId}`);
  const taxas = await chamar('GET', `${API_V2}/${companyId}/municipaltaxes`);
  if (empresa.status !== 200 || taxas.status !== 200) {
    const fora = [empresa.status, taxas.status].some((st) => st >= 500 || st === 429);
    throw new ErroNfeio(fora ? 'indisponivel' : 'bloqueada', `trava: não foi possível consultar a empresa (HTTP ${empresa.status}/${taxas.status})`);
  }
  const ambientes = taxas.dados.municipalTaxes.map((t) => t.environment);
  const estaduais = empresa.dados.company.stateTaxes || [];
  // Um ambiente só (nunca misturado); Production só com a liberação.
  const permitidos = producaoLiberada() ? ['Development', 'Production'] : ['Development'];
  const unico = ambientes.length && ambientes.every((a) => a === ambientes[0]);
  if (!unico || !permitidos.includes(ambientes[0]) || estaduais.length) {
    throw new ErroNfeio('bloqueada', `trava: ambiente não permitido (municipais=${ambientes}, estaduais=${estaduais.length}, permitidos=${permitidos})`);
  }
}

// Únicos campos do payload no caso comum. Nenhum é de imposto: a NFE.io calcula o ISS
// pela configuração da empresa, e caso tributário especial vai para o colaborador (E3).
const CAMPOS_PAYLOAD_COMUM = ['externalId', 'borrower', 'cityServiceCode', 'description', 'servicesAmount', 'accrualOn', 'federalServiceCode', 'nbsCode'];

// referencia: id do pedido, vai como externalId (permite achar a nota depois de uma falha de rede).
function montarPayload(dados, servico, referencia) {
  const doc = dados.tomador.documento;
  const borrower = {
    type: doc.length === 14 ? 'LegalEntity' : 'NaturalPerson',
    name: dados.tomador.nome,
    federalTaxNumber: Number(doc),
    // Sem e-mail do tomador de propósito: a NFE.io poderia enviar a nota a ele.
  };
  if (dados.tomador.endereco) borrower.address = dados.tomador.endereco;
  const payload = {
    externalId: referencia,
    borrower,
    cityServiceCode: servico.city_service_code,
    description: (process.env.DESCRICAO_PREFIXO || '') + dados.descricao,
    servicesAmount: dados.valor_centavos / 100,
    // Competência (AAAA-MM) como o primeiro dia do mês; sem ela a NFE.io usa a data de emissão.
    accrualOn: `${dados.competencia}-01`,
  };
  if (servico.federal_service_code) payload.federalServiceCode = servico.federal_service_code;
  if (servico.nbs_code) payload.nbsCode = servico.nbs_code;
  return payload;
}

async function emitir(companyId, payload) {
  await travaAmbiente(companyId);
  const r = await chamar('POST', `${API_V1}/${companyId}/serviceinvoices`, payload);
  if (r.status >= 300) {
    const msg = `NFE.io HTTP ${r.status}: ${JSON.stringify(r.dados).slice(0, 500)}`;
    if (r.status === 429) throw new ErroNfeio('indisponivel', msg);
    if (r.status >= 400 && r.status < 500 && r.status !== 408) throw new ErroNfeio('rejeitada', msg);
    throw new ErroNfeio('incerta', msg); // 5xx ou 408: a nota pode ter sido criada
  }
  return r.dados; // { id, flowStatus, ... }
}

async function status(companyId, invoiceId) {
  const r = await chamar('GET', `${API_V1}/${companyId}/serviceinvoices/${invoiceId}`);
  if (r.status !== 200) throw new ErroNfeio('indisponivel', `NFE.io status HTTP ${r.status}`);
  return r.dados;
}

// Notas criadas com esta referência (externalId). Lista vazia = a NFE.io diz que não existe.
// Na prática (teste externo de 13/10/2026) a API responde 200 com { serviceInvoices: [...] }, e lista
// vazia quando não acha; o spec fala em 404 e objeto único, então os dois formatos são aceitos.
async function consultarPorReferencia(companyId, referencia) {
  const r = await chamar('GET', `${API_V1}/${companyId}/serviceinvoices/external/${encodeURIComponent(referencia)}`);
  if (r.status === 404) return [];
  if (r.status !== 200 || !r.dados || typeof r.dados !== 'object') {
    throw new ErroNfeio('indisponivel', `NFE.io consulta por referência HTTP ${r.status}`);
  }
  const notas = Array.isArray(r.dados.serviceInvoices) ? r.dados.serviceInvoices : r.dados.id ? [r.dados] : null;
  if (!notas) throw new ErroNfeio('indisponivel', `NFE.io consulta por referência: resposta inesperada ${JSON.stringify(r.dados).slice(0, 200)}`);
  // Só vale nota com exatamente esta referência.
  return notas.filter((n) => n.externalId === undefined || n.externalId === referencia);
}

async function baixar(companyId, invoiceId, formato) {
  const r = await chamar('GET', `${API_V1}/${companyId}/serviceinvoices/${invoiceId}/${formato}`, null, true);
  if (r.status !== 200) throw new Error(`NFE.io ${formato} HTTP ${r.status}`);
  return r.dados;
}

// flowStatus finais conhecidos; qualquer outro "Waiting*" é intermediário.
const concluida = (nota) => !String(nota.flowStatus || '').startsWith('Waiting');

module.exports = { montarPayload, emitir, producaoLiberada, status, consultarPorReferencia, baixar, concluida, ErroNfeio, CAMPOS_PAYLOAD_COMUM };
