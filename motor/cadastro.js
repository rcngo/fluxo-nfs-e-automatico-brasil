// Normalização dos dados de cadastro, comum à importação por planilha (scripts/importar.js)
// e às telas do painel (motor/painel.js).

const digitos = (s) => String(s || '').replace(/\D/g, '');

function reaisParaCentavos(s) {
  let v = String(s || '').replace(/R\$|\s/gi, '');
  if (!v) return null;
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  else if (!/^\d+\.\d{1,2}$/.test(v)) v = v.replace(/\./g, '');
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

function simNao(s, padrao) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) return padrao;
  if (['sim', 's', 'x', 'true', '1', 'yes'].includes(v)) return true;
  if (['não', 'nao', 'n', 'false', '0', 'no'].includes(v)) return false;
  return undefined;
}

function telefone(s) {
  let d = digitos(s);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length === 12 || d.length === 13 ? `+${d}` : null;
}

const emailValido = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Coluna "retencao" de servicos.csv: tipos de tomador separados por "/", "," ou " e "
// (ex.: "PJ / órgão público"). Vazio ou "não" = nenhum. Devolve undefined se algo não for reconhecido.
const TIPOS_RETENCAO = { pf: 'pf', 'pessoa fisica': 'pf', pj: 'pj', 'pessoa juridica': 'pj', 'orgao publico': 'orgao_publico', publico: 'orgao_publico' };
function tiposRetencao(s) {
  const v = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (!v || ['nao', 'n', 'nenhum'].includes(v)) return [];
  const tipos = v.split(/\s*(?:[,/+;]|\be\b)\s*/).filter(Boolean).map((t) => TIPOS_RETENCAO[t.replace(/\s+/g, ' ')]);
  return tipos.every(Boolean) ? [...new Set(tipos)] : undefined;
}

module.exports = { digitos, reaisParaCentavos, simNao, telefone, emailValido, tiposRetencao };
