const test = require('node:test');
const assert = require('node:assert');
const { adicionarDiasUteis } = require('./prazos');

const local = (d) => d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16);

test('dias úteis pulam o fim de semana e mantêm o horário', () => {
  // 15/10/2026 é quinta-feira.
  assert.strictEqual(local(adicionarDiasUteis(new Date('2026-10-15T10:00:00-03:00'), 1)), '2026-10-16 10:00'); // sexta
  assert.strictEqual(local(adicionarDiasUteis(new Date('2026-10-15T10:00:00-03:00'), 2)), '2026-10-19 10:00'); // segunda
  assert.strictEqual(local(adicionarDiasUteis(new Date('2026-10-17T09:00:00-03:00'), 1)), '2026-10-19 09:00'); // sábado → segunda
  assert.strictEqual(local(adicionarDiasUteis(new Date('2026-10-19T23:30:00-03:00'), 2)), '2026-10-21 23:30'); // virada de dia no fuso
});
