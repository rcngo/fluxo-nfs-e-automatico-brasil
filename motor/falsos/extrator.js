// Extrator falso: substitui o Claude nos cenários, sem rede e sem custo.
// Lê a conversa com expressões regulares simples e devolve o mesmo JSON do schema de extração
// (schemas/extracao.schema.json). Serve para testar o FLUXO; a qualidade da extração real é
// medida pela avaliação (avaliacao/rodar.js) com o Claude de verdade.
//
// Cada passo de cenário pode sobrescrever campos com `ia:` para simular o que a regex não cobre
// (valor ambíguo, várias notas...) ou `ia: { falha: true }` para simular falha da IA.

const MESES = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const campo = (valor = null, trecho = null) => ({ valor, trecho });

const RE_DOC = /(?<!\d)(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g;
const RE_VALOR = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/i;
const RE_MES = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b(?:\s*(?:de|\/)?\s*(\d{4}))?/;
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const RE_INSTRUCAO = /ignore|ignorar|desconsider|instruc[oõ]es anteriores|sem confer|pule a valida/i;
// Sem acento, minúsculas.
const RE_LIQUIDO = /liquid|quero receber|preciso receber|limpo|descontad/;
const RE_BRUTO = /\bbrut[oa]\b/;
const RE_EXTERIOR = /exterior|estrangeir|estados unidos|portugal|\bdolar/;
const RE_NOTA_EMITIDA = /(cancel\w*|substitu\w*|refaz\w*|corrig\w*) (a |essa |aquela |esta )?nota|nota (n\S* ?)?\d+ (saiu|veio|esta) errad|saiu errad/;
const RE_TRIBUTOS = /retenc|retid|\breter\b|\biss\b|\binss\b|\birrf?\b|aliquota|imposto/;

// Palavra inteira do texto original em volta de um trecho achado no texto sem acento
// (os dois têm o mesmo comprimento para texto em NFC).
function palavra(texto, m) {
  let a = m.index;
  let b = m.index + m[0].length;
  while (a > 0 && /[\p{L}\d]/u.test(texto[a - 1])) a--;
  while (b < texto.length && /[\p{L}\d]/u.test(texto[b])) b++;
  return texto.slice(a, b);
}

function lerDados(texto, servicos) {
  const d = {};
  const docs = [...texto.matchAll(RE_DOC)];
  if (docs.length) {
    const m = docs[docs.length - 1][0];
    d.tomador_documento = campo(m.replace(/\D/g, ''), m);
  }
  const v = texto.match(RE_VALOR);
  const t = semAcento(texto);
  if (v) {
    const tipo = RE_LIQUIDO.test(t) ? 'liquido' : RE_BRUTO.test(t) ? 'bruto' : 'nao_informado';
    d.valor = { centavos: Number(v[1].replace(/\./g, '')) * 100 + Number(v[2] || 0), trecho: v[0], ambiguo: false, tipo };
  }
  const exterior = t.match(RE_EXTERIOR);
  if (exterior) d.tomador_exterior = { valor: true, trecho: palavra(texto, exterior) };
  const notaEmitida = t.match(RE_NOTA_EMITIDA);
  if (notaEmitida) d.refere_nota_emitida = { valor: true, trecho: palavra(texto, notaEmitida) };
  const tributos = t.match(RE_TRIBUTOS);
  if (tributos) d.menciona_tributos = { valor: true, trecho: palavra(texto, tributos) };
  const mes = t.match(RE_MES);
  if (mes) d.competencia = { mes: MESES[mes[1]], ano: mes[2] ? Number(mes[2]) : null, trecho: mes[0] };
  const email = texto.match(RE_EMAIL);
  if (email) d.tomador_email = campo(email[0], email[0]);
  for (const s of servicos || []) {
    const chaves = [s.apelido, ...String(s.descricao_padrao || '').split(/\s+/).filter((p) => p.length >= 5)].map(semAcento);
    const achou = chaves.find((k) => k && t.includes(k));
    if (achou) {
      d.servico_id = { valor: s.id, trecho: achou };
      break;
    }
  }
  return d;
}

function extratorFalso() {
  let sobrescrita = null;

  function extrairSincrono({ servicos, mensagens }) {
    const idxEntradas = mensagens.map((m, i) => (m.direcao === 'entrada' ? i : -1)).filter((i) => i >= 0);
    const idxSaidas = mensagens.map((m, i) => (m.direcao === 'saida' ? i : -1)).filter((i) => i >= 0);
    const ultEntrada = idxEntradas.length ? mensagens[idxEntradas[idxEntradas.length - 1]].conteudo : '';
    const ultSaidaIdx = idxSaidas.length ? idxSaidas[idxSaidas.length - 1] : -1;
    const aguardandoSim = ultSaidaIdx >= 0 && /Responda SIM/i.test(mensagens[ultSaidaIdx].conteudo)
      && idxEntradas[idxEntradas.length - 1] > ultSaidaIdx;

    // Consolida a conversa: a informação mais recente vale.
    const dados = {};
    for (const i of idxEntradas) Object.assign(dados, lerDados(mensagens[i].conteudo, servicos));
    const novosNaUltima = lerDados(ultEntrada, servicos);

    let intencao;
    let resposta = null;
    const t = semAcento(ultEntrada.trim());
    if (aguardandoSim && /^(sim|pode emitir|pode|confirmo|ok)\b/.test(t)) [intencao, resposta] = ['confirmacao', 'sim'];
    else if (aguardandoSim && /^(nao|cancela)/.test(t)) [intencao, resposta] = ['confirmacao', 'nao'];
    else if (aguardandoSim && Object.keys(novosNaUltima).length === 0) intencao = 'confirmacao';
    else if (/cancel/.test(t)) intencao = 'cancelar_pedido';
    else if (!dados.tomador_documento && !dados.valor && !dados.servico_id && !/\bnota\b/.test(semAcento(mensagens.map((m) => m.conteudo).join(' ')))) intencao = 'outro';
    else intencao = idxEntradas.length === 1 ? 'pedido_nota' : 'complemento';

    return {
      intencao,
      multiplas_notas: false,
      tomador_documento: dados.tomador_documento || campo(),
      tomador_nome: campo(),
      tomador_email: dados.tomador_email || campo(),
      servico_id: dados.servico_id || campo(),
      descricao: campo(),
      valor: dados.valor || { centavos: null, trecho: null, ambiguo: false, tipo: 'nao_informado' },
      tomador_exterior: dados.tomador_exterior || { valor: false, trecho: null },
      menciona_tributos: dados.menciona_tributos || { valor: false, trecho: null },
      refere_nota_emitida: dados.refere_nota_emitida || { valor: false, trecho: null },
      competencia: dados.competencia || { mes: null, ano: null, trecho: null },
      resposta_confirmacao: resposta,
      contem_instrucoes_ao_sistema: idxEntradas.some((i) => RE_INSTRUCAO.test(mensagens[i].conteudo)),
      observacao: null,
    };
  }

  return {
    // Vale só para a próxima chamada de extrair().
    sobrescrever(campos) { sobrescrita = campos || null; },
    async extrair(contexto) {
      const s = sobrescrita;
      sobrescrita = null;
      if (s && s.falha) return { ok: false, motivo: 'falha simulada da IA' };
      const extracao = extrairSincrono(contexto);
      for (const [k, v] of Object.entries(s || {})) {
        extracao[k] = v && typeof v === 'object' && !Array.isArray(v) && extracao[k] && typeof extracao[k] === 'object'
          ? { ...extracao[k], ...v }
          : v;
      }
      return { ok: true, extracao, modelo: 'extrator-falso', versao_prompt: 'falso', usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
}

module.exports = { extratorFalso };
