// Testes contra serviços reais, rodados só sob comando (nunca em `npm test` nem nos cenários).
//
//   set -a && . infra/secrets.env && set +a && npm run teste:externo -- nfeio
//
// nfeio: emite UMA nota no ambiente de testes da NFE.io (a trava de motor/nfeio.js recusa se a
// empresa não estiver só em Development), com competência do mês anterior e a referência do
// pedido; confere a consulta pela referência e baixa PDF e XML para saida/teste-externo/.

const fs = require('node:fs');
const path = require('node:path');
const nfeio = require('../motor/nfeio');

const RAIZ = path.resolve(__dirname, '..');
// Empresa de testes na NFE.io (ambiente Development): NFEIO_COMPANY_ID em infra/secrets.env.
const EMPRESA = process.env.NFEIO_COMPANY_ID;
if (!EMPRESA) throw new Error('defina NFEIO_COMPANY_ID em infra/secrets.env (empresa de testes na NFE.io)');

function competenciaAnterior(hoje = new Date()) {
  const d = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function testeNfeio() {
  if (!process.env.NFEIO_API_KEY) throw new Error('defina NFEIO_API_KEY (infra/secrets.env)');
  const competencia = competenciaAnterior();
  const referencia = `teste-externo-${Date.now()}`;
  const falhas = [];
  const conferir = (ok, msg) => { console.log(`${ok ? '✔' : '✖'} ${msg}`); if (!ok) falhas.push(msg); };

  conferir((await nfeio.consultarPorReferencia(EMPRESA, referencia)).length === 0, `consulta por referência inexistente devolve "não existe" (${referencia})`);

  const dados = {
    tomador: {
      documento: '75768426000199',
      nome: 'AGRO EXEMPLO COMERCIO LTDA',
      endereco: { country: 'BRA', postalCode: '80010000', street: 'Rua das Flores', number: '100', additionalInformation: '', district: 'Centro', city: { code: '4106902', name: 'Curitiba' }, state: 'PR' },
    },
    descricao: `TESTE EXTERNO, sem valor fiscal — Competência ${competencia}`,
    valor_centavos: 100,
    competencia,
  };
  const servico = { city_service_code: '010201', federal_service_code: '010201', nbs_code: '115021000' };
  const payload = nfeio.montarPayload(dados, servico, referencia);
  console.log(`  payload: competência ${payload.accrualOn}, referência ${payload.externalId}, valor R$ ${payload.servicesAmount}`);

  let nota = await nfeio.emitir(EMPRESA, payload); // a trava de ambiente roda aqui
  console.log(`  nota criada: ${nota.id} (${nota.flowStatus})`);
  for (let i = 0; i < 20 && !nfeio.concluida(nota); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    nota = await nfeio.status(EMPRESA, nota.id);
  }
  conferir(nota.flowStatus === 'Issued', `nota emitida no ambiente ${nota.environment} (flowStatus ${nota.flowStatus}${nota.flowMessage ? `: ${nota.flowMessage}` : ''})`);
  conferir(nota.environment === 'Development', 'ambiente Development (simulador, sem valor fiscal)');

  const achadas = await nfeio.consultarPorReferencia(EMPRESA, referencia);
  conferir(achadas.length === 1 && achadas[0].id === nota.id, `consulta pela referência acha a mesma nota (${achadas.map((n) => n.id).join(', ')})`);

  console.log(`  datas na nota: emissão ${nota.issuedOn}, competência ${nota.accrualOn}`);
  conferir(String(nota.accrualOn || '').startsWith(payload.accrualOn), `a NFE.io registrou a competência ${payload.accrualOn} (e não a data de emissão)`);

  const pasta = path.join(RAIZ, 'saida/teste-externo');
  fs.mkdirSync(pasta, { recursive: true });
  const pdf = await nfeio.baixar(EMPRESA, nota.id, 'pdf');
  const xml = await nfeio.baixar(EMPRESA, nota.id, 'xml');
  fs.writeFileSync(path.join(pasta, `${nota.id}.pdf`), pdf);
  fs.writeFileSync(path.join(pasta, `${nota.id}.xml`), xml);
  conferir(pdf.subarray(0, 4).toString() === '%PDF', `PDF baixado (${pdf.length} bytes)`);
  conferir(xml.length > 0, `XML baixado (${xml.length} bytes) em saida/teste-externo/`);

  const texto = xml.toString('utf8');
  const tags = [...texto.matchAll(/<(Competencia|dCompet)>([^<]*)</g)].map((m) => `${m[1]}=${m[2]}`);
  // O XML do simulador (Development) é um modelo simplificado, sem tag de competência; no XML
  // real (padrão nacional) ela é dCompet. Se a tag existir, tem que bater.
  if (tags.length) conferir(tags.some((t) => t.includes(`=${competencia}`)), `XML com a competência ${competencia} (${tags.join(', ')})`);
  else console.log('  ○ o XML do simulador não tem tag de competência (só DataEmissao); conferida pela nota acima');

  return falhas;
}

const TESTES = { nfeio: testeNfeio };

async function main() {
  const qual = process.argv[2];
  if (!TESTES[qual]) throw new Error(`uso: npm run teste:externo -- <${Object.keys(TESTES).join('|')}>`);
  const falhas = await TESTES[qual]();
  console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\nok');
  process.exit(falhas.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`✖ ${e.tipo ? `[${e.tipo}] ` : ''}${e.message}`);
  process.exit(1);
});
