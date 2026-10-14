// Extração com Claude: monta o prompt a partir do contexto e devolve o JSON do schema.
// montarUserPrompt() é puro e vai para o nó Code do n8n; extrair() é usado pelo script de avaliação.

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const VERSAO_PROMPT = 'extracao-v3';
const MODELO = process.env.MODELO || 'claude-opus-5';
// O comentário HTML da primeira linha é só para humanos; não vai para o modelo.
const SYSTEM_PROMPT = fs
  .readFileSync(path.join(RAIZ, 'prompts/extracao_system.md'), 'utf8')
  .replace(/^<!--.*?-->\s*/s, '');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(RAIZ, 'schemas/extracao.schema.json'), 'utf8'));

// Mesmo formato de prompts/extracao_user_template.md.
function montarUserPrompt({ hoje, canal, prestador, servicos, dadosJaColetados, mensagens }) {
  const linhasServicos = servicos
    .map((s) => `- id: ${s.id} | apelido: ${s.apelido} | descricao: ${s.descricao_padrao}`)
    .join('\n');
  const conversa = mensagens
    .map((m) => `<mensagem direcao="${m.direcao}" data="${m.data}">\n${m.conteudo}\n</mensagem>`)
    .join('\n');
  return `<contexto>
data_hoje: ${hoje}
canal: ${canal}
prestador: ${prestador.razao_social} (CNPJ ${prestador.cnpj})
servicos_cadastrados:
${linhasServicos}
</contexto>

<dados_ja_coletados>
${dadosJaColetados ? JSON.stringify(dadosJaColetados) : '(nenhum)'}
</dados_ja_coletados>

<conversa>
${conversa}
</conversa>`;
}

// Modelos sem o fallback do servidor em caso de recusa (o parâmetro dá erro): Haiku.
const SEM_FALLBACK = /haiku/;

// opcoes.modelo / opcoes.effort: para a avaliação comparar modelos; o motor usa o padrão.
async function extrair(client, contexto, { modelo = MODELO, effort = 'low' } = {}) {
  const resposta = await client.beta.messages.create({
    model: modelo,
    max_tokens: 4000,
    ...(SEM_FALLBACK.test(modelo) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: montarUserPrompt(contexto) }],
  });

  // Recusa ou corte: nunca segue para emissão.
  if (resposta.stop_reason !== 'end_turn') {
    return { ok: false, motivo: `stop_reason=${resposta.stop_reason}`, resposta };
  }
  const texto = resposta.content.find((b) => b.type === 'text');
  return {
    ok: true,
    extracao: JSON.parse(texto.text),
    modelo: resposta.model,
    versao_prompt: VERSAO_PROMPT,
    usage: resposta.usage,
  };
}

module.exports = { montarUserPrompt, extrair, VERSAO_PROMPT, MODELO };
