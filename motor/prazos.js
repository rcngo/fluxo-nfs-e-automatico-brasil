// Prazos em dias úteis (segunda a sexta, no fuso de Brasília). Feriados não são considerados.

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 24 * 60 * 60 * 1000;

const fimDeSemana = (data) => ['Sat', 'Sun'].includes(data.toLocaleDateString('en-US', { weekday: 'short', timeZone: FUSO }));

// Mesmo horário, n dias úteis depois. Ex.: quinta 10h + 2 dias úteis = segunda 10h.
function adicionarDiasUteis(data, n) {
  let t = new Date(data).getTime();
  let contados = 0;
  while (contados < n) {
    t += DIA_MS;
    if (!fimDeSemana(new Date(t))) contados++;
  }
  return new Date(t);
}

module.exports = { adicionarDiasUteis };
