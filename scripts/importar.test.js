const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { lerCsv, validarCadastro, reaisParaCentavos, telefone, tiposRetencao } = require('./importar');

const vazio = () => ({ colaboradores: new Set(), empresas: new Set(), servicos: new Set(), remetentes: new Set(), tomadores: new Set() });

test('CSV com ";" (Excel em português), aspas e BOM', () => {
  const linhas = lerCsv('﻿nome;email\r\n"Silva; Maria";maria@x.com\r\n\r\n"Ana ""A""";ana@x.com\n');
  assert.deepStrictEqual(linhas.map((l) => l.campos), [
    { nome: 'Silva; Maria', email: 'maria@x.com' },
    { nome: 'Ana "A"', email: 'ana@x.com' },
  ]);
  assert.deepStrictEqual(linhas.map((l) => l.linha), [2, 3]);
  assert.strictEqual(lerCsv('a,b\n1,2').length, 1);
});

test('valores e telefones', () => {
  assert.strictEqual(reaisParaCentavos('50.000,00'), 5000000);
  assert.strictEqual(reaisParaCentavos('R$ 1.500,5'), 150050);
  assert.strictEqual(reaisParaCentavos('50000'), 5000000);
  assert.strictEqual(reaisParaCentavos('1.500'), 150000);
  assert.strictEqual(reaisParaCentavos('99.90'), 9990);
  assert.ok(Number.isNaN(reaisParaCentavos('abc')));
  assert.strictEqual(telefone('(64) 99999-1234'), '+5564999991234');
  assert.strictEqual(telefone('+55 64 99999-1234'), '+5564999991234');
  assert.strictEqual(telefone('1234'), null);
});

test('modelo em docs/modelo-cadastro é válido', () => {
  const pasta = path.join(__dirname, '../docs/modelo-cadastro');
  const planilhas = {};
  for (const f of fs.readdirSync(pasta).filter((f) => f.endsWith('.csv'))) planilhas[f.replace('.csv', '')] = lerCsv(fs.readFileSync(path.join(pasta, f), 'utf8'));
  const { erros, plano } = validarCadastro(planilhas, vazio());
  assert.deepStrictEqual(erros, []);
  assert.ok(plano.empresas.length && plano.servicos.length && plano.remetentes.length && plano.colaboradores.length && plano.tomadores.length);
});

test('planilha com 3 linhas erradas: aponta as 3 e aproveita as válidas', () => {
  const planilhas = {
    colaboradores: lerCsv('nome;email;whatsapp;padrao\nCarlos;carlos@escritorio.com;(64) 99999-0000;sim\n'),
    empresas: lerCsv(
      'cnpj;razao_social;nfeio_company_id;municipio_ibge;valor_minimo;valor_maximo;exige_confirmacao;colaborador_email\n' +
      '82.571.297/0001-00;MODELO E CIA;abc123;5205109;100,00;50.000,00;não;carlos@escritorio.com\n' +
      '82.571.297/0001-99;EMPRESA ERRADA;def;5205109;;10.000,00;sim;\n', // erro 1: CNPJ inválido
    ),
    servicos: lerCsv(
      'empresa_cnpj;apelido;descricao_padrao;codigo_servico_municipal;codigo_tributacao_nacional;nbs\n' +
      '82571297000100;programação;Serviço de Programador;010201;010201;115021000\n',
    ),
    remetentes: lerCsv(
      'empresa_cnpj;canal;identificador;nome\n' +
      '82571297000100;email;Cliente.Exemplo@Hotmail.com;Titular\n' +
      '82571297000100;telegram;123;X\n' + // erro 2: canal inválido
      '82571297000199;email;a@b.com;Y\n', // erro 3: empresa com erro
    ),
    tomadores: lerCsv('empresa_cnpj;documento;nome;email\n82571297000100;75.768.426/0001-99;AGRO EXEMPLO;\n'),
  };
  const { erros, plano } = validarCadastro(planilhas, vazio());
  assert.strictEqual(erros.length, 3, JSON.stringify(erros, null, 2));
  assert.deepStrictEqual(erros.map((e) => `${e.arquivo}:${e.linha}`), ['empresas.csv:3', 'remetentes.csv:3', 'remetentes.csv:4']);
  assert.match(erros[0].msg, /CNPJ inválido/);
  assert.match(erros[1].msg, /canal/);
  assert.match(erros[2].msg, /tem erro em empresas\.csv/);

  assert.strictEqual(plano.empresas.length, 1);
  assert.strictEqual(plano.empresas[0].dados.valor_max_centavos, 5000000);
  assert.strictEqual(plano.empresas[0].dados.exige_confirmacao, false);
  assert.strictEqual(plano.remetentes[0].dados.identificador, 'cliente.exemplo@hotmail.com');
  assert.strictEqual(plano.colaboradores[0].dados.whatsapp, '+5564999990000');
  assert.strictEqual(plano.servicos.length, 1);
  assert.strictEqual(plano.tomadores.length, 1);
});

test('referências: colaborador inexistente, empresa já no banco, atualização', () => {
  const existentes = vazio();
  existentes.empresas.add('82571297000100');
  existentes.servicos.add('82571297000100|programação');
  const { erros, plano } = validarCadastro({
    empresas: lerCsv('cnpj;razao_social;nfeio_company_id;municipio_ibge;valor_maximo;colaborador_email\n81452590000195;AURORA;x;5205109;1000;ninguem@x.com\n'),
    servicos: lerCsv('empresa_cnpj;apelido;descricao_padrao;codigo_servico_municipal\n82571297000100;Programação;Novo texto;010201\n'),
  }, existentes);
  assert.strictEqual(erros.length, 1);
  assert.match(erros[0].msg, /colaborador não encontrado/);
  assert.strictEqual(plano.servicos[0].acao, 'atualiza'); // empresa já existe no banco; apelido comparado em minúsculas
});

test('serviços: retenção por tipo de tomador e ISS fora do município (E3)', () => {
  assert.deepStrictEqual(tiposRetencao('PJ / órgão público'), ['pj', 'orgao_publico']);
  assert.deepStrictEqual(tiposRetencao('Pessoa Física e PJ'), ['pf', 'pj']);
  assert.deepStrictEqual(tiposRetencao('não'), []);
  assert.strictEqual(tiposRetencao('sim'), undefined); // precisa dizer para qual tomador

  const existentes = vazio();
  existentes.empresas.add('82571297000100');
  const { erros, plano } = validarCadastro({
    servicos: lerCsv(
      'empresa_cnpj;apelido;descricao_padrao;codigo_servico_municipal;retencao;iss_fora_do_municipio\n' +
      '82571297000100;programação;Serviço de Programador;010201;PJ;não\n' +
      '82571297000100;obra;Construção;070201;;sim\n' +
      '82571297000100;limpeza;Limpeza;071001;sim;\n' + // erro: retenção sem tipo de tomador
      '82571297000100;vigilancia;Vigilância;110201;PF;talvez\n', // erro: sim/não
    ),
  }, existentes);
  assert.deepStrictEqual(erros.map((e) => e.linha), [4, 5]);
  assert.match(erros[0].msg, /retencao deve listar PF, PJ/);
  assert.match(erros[1].msg, /iss_fora_do_municipio deve ser sim ou não/);
  assert.deepStrictEqual(plano.servicos.map((s) => [s.dados.pode_ter_retencao, s.dados.iss_pode_ser_devido_fora]), [[['pj'], false], [[], true]]);

  // Planilha sem as colunas novas: não mexe no que o contador já marcou (null = manter).
  const antiga = validarCadastro({ servicos: lerCsv('empresa_cnpj;apelido;descricao_padrao;codigo_servico_municipal\n82571297000100;programação;X;010201\n') }, existentes);
  assert.strictEqual(antiga.plano.servicos[0].dados.pode_ter_retencao, null);
  assert.strictEqual(antiga.plano.servicos[0].dados.iss_pode_ser_devido_fora, null);
});
