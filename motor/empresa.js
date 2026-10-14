// Escolha da empresa (prestador) quando o remetente pode pedir nota para mais de uma.
// Determinístico: procura na conversa o CNPJ ou o nome de uma das empresas, ou a resposta
// (número ou nome) à pergunta "Para qual empresa é esta nota?". Sem IA.

const MARCA_PERGUNTA = 'Para qual empresa é esta nota?';

// Palavras que não distinguem uma empresa de outra.
const GENERICAS = new Set([
  'ltda', 'eireli', 'epp', 'me', 'mei', 'sa', 'cia', 'companhia', 'empresa', 'grupo',
  'de', 'da', 'do', 'das', 'dos', 'e', 'em',
  'servicos', 'servico', 'comercio', 'industria', 'consultoria', 'assessoria', 'desenvolvimento',
  'tecnologia', 'solucoes', 'gestao', 'administracao', 'contabilidade', 'participacoes',
  'brasil', 'web', 'site', 'sites', 'digital',
]);

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palavras = (s) => normalizar(s).split(/[^a-z0-9]+/).filter(Boolean);
const RE_DOC = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;

// Mesma ordem na pergunta e na leitura da resposta numérica.
const ordenar = (candidatos) => [...candidatos].sort((a, b) => a.razao_social.localeCompare(b.razao_social, 'pt-BR'));

function perguntaEmpresa(candidatos) {
  const linhas = ordenar(candidatos).map((p, i) => `${i + 1}. ${p.razao_social} (CNPJ ${p.cnpj})`);
  return `Você pode pedir notas para mais de uma empresa. ${MARCA_PERGUNTA}\n${linhas.join('\n')}\nResponda com o número ou o nome da empresa.`;
}

// Empresas apontadas pelos textos: CNPJ citado ou palavra do nome que só ela tem.
function apontadas(ordem, textos) {
  const docs = new Set(textos.flatMap((t) => [...t.matchAll(RE_DOC)].map((d) => d[0].replace(/\D/g, ''))));
  const porCnpj = ordem.filter((p) => docs.has(p.cnpj));

  const contagem = new Map();
  const distintivas = new Map(
    ordem.map((p) => {
      const ps = [...new Set(palavras(p.razao_social).filter((w) => w.length >= 4 && !GENERICAS.has(w)))];
      for (const w of ps) contagem.set(w, (contagem.get(w) || 0) + 1);
      return [p.id, ps];
    }),
  );
  const texto = new Set(textos.flatMap(palavras));
  const porNome = ordem.filter((p) => distintivas.get(p.id).some((w) => contagem.get(w) === 1 && texto.has(w)));

  return { lista: [...new Set([...porCnpj, ...porNome])], porCnpj };
}

/**
 * @param {object[]} candidatos   prestadores que o remetente pode representar ({ id, cnpj, razao_social })
 * @param {object[]} mensagens    conversa em ordem ({ direcao: 'entrada'|'saida', conteudo })
 * @returns {{ prestador: object, como: string } | null}  null = ambíguo, perguntar
 */
function escolherEmpresa(candidatos, mensagens) {
  const ordem = ordenar(candidatos);

  // 1. Resposta logo depois da pergunta: vale só ela (número ou nome/CNPJ).
  const ultima = mensagens[mensagens.length - 1];
  const anterior = mensagens[mensagens.length - 2];
  if (ultima && ultima.direcao === 'entrada' && anterior && anterior.direcao === 'saida' && anterior.conteudo.includes(MARCA_PERGUNTA)) {
    const n = ultima.conteudo.trim().match(/^(\d{1,2})\s*[).-]?\s*$/);
    if (n && ordem[Number(n[1]) - 1]) return { prestador: ordem[Number(n[1]) - 1], como: 'resposta_numerica' };
    const r = apontadas(ordem, [ultima.conteudo]);
    if (r.lista.length === 1) return { prestador: r.lista[0], como: 'resposta_nome' };
  }

  // 2. Pistas na conversa inteira. Só decide quando todas apontam para a mesma empresa.
  // Ex.: "nota da A para a B" cita o nome de A e o CNPJ de B (que aí é o tomador): ambíguo.
  const r = apontadas(ordem, mensagens.filter((m) => m.direcao === 'entrada').map((m) => m.conteudo));
  if (r.lista.length === 1) return { prestador: r.lista[0], como: r.porCnpj.length ? 'cnpj' : 'nome' };
  return null;
}

module.exports = { escolherEmpresa, perguntaEmpresa, MARCA_PERGUNTA };
