const test = require('node:test');
const assert = require('node:assert');
const { escolherEmpresa, perguntaEmpresa } = require('./empresa');

const A = { id: 'a', cnpj: '82571297000100', razao_social: 'MODELO E CIA DESENVOLVIMENTO DE SISTEMAS LTDA' };
const B = { id: 'b', cnpj: '81452590000195', razao_social: 'AURORA SERVICOS DIGITAIS LTDA' };
const entrada = (conteudo) => ({ direcao: 'entrada', conteudo });
const saida = (conteudo) => ({ direcao: 'saida', conteudo });

test('sem pista: ambíguo', () => {
  assert.strictEqual(escolherEmpresa([A, B], [entrada('Nota de R$ 3.500,00 para 75.768.426/0001-99')]), null);
});

test('CNPJ da empresa citado', () => {
  const r = escolherEmpresa([A, B], [entrada('Pela 81.452.590/0001-95, nota de R$ 100,00 para 75.768.426/0001-99')]);
  assert.strictEqual(r.prestador.id, 'b');
  assert.strictEqual(r.como, 'cnpj');
});

test('nome da empresa citado (palavra que só ela tem)', () => {
  assert.strictEqual(escolherEmpresa([A, B], [entrada('Nota pela Aurora, R$ 100,00')]).prestador.id, 'b');
  assert.strictEqual(escolherEmpresa([A, B], [entrada('emitir pela modelo e cia')]).prestador.id, 'a');
  // Palavras genéricas ("ltda", "servicos"...) não identificam empresa.
  assert.strictEqual(escolherEmpresa([A, B], [entrada('emitir pela ltda')]), null);
});

test('nome de uma e CNPJ da outra (a outra é o tomador): ambíguo', () => {
  assert.strictEqual(escolherEmpresa([A, B], [entrada('Nota da Modelo e Cia para a 81.452.590/0001-95')]), null);
});

test('resposta à pergunta: número ou nome', () => {
  const pergunta = perguntaEmpresa([B, A]);
  // Ordem alfabética: 1 = AURORA, 2 = MODELO E CIA.
  assert.match(pergunta, /1\. AURORA[\s\S]*2\. MODELO E CIA/);
  const base = [entrada('Nota da Modelo e Cia para a 81.452.590/0001-95'), saida(pergunta)];
  assert.strictEqual(escolherEmpresa([A, B], [...base, entrada('2')]).prestador.id, 'a');
  assert.strictEqual(escolherEmpresa([A, B], [...base, entrada('1)')]).prestador.id, 'b');
  assert.strictEqual(escolherEmpresa([A, B], [...base, entrada('A Modelo e Cia')]).prestador.id, 'a');
  assert.strictEqual(escolherEmpresa([A, B], [...base, entrada('7')]), null);
});
