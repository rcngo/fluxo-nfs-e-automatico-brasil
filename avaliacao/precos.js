// Preço por milhão de tokens (US$), API da Anthropic, tabela de 06/10/2026. Usado só para estimar o
// custo da avaliação. Escrita no cache: 1,25× a entrada.
// Cache de leitura: Opus 5.5 e Sonnet 5.5 conforme a tabela (US$ 0,20); demais, 0,1× a entrada.
const PRECOS = {
  'claude-opus-5': { entrada: 5, saida: 25, cache_leitura: 0.5 },
  'claude-opus-5-5': { entrada: 4, saida: 20, cache_leitura: 0.2 },
  'claude-sonnet-5-5': { entrada: 2, saida: 10, cache_leitura: 0.2 },
  'claude-haiku-5-5': { entrada: 0.1, saida: 0.5, cache_leitura: 0.01 },
};

module.exports = { PRECOS };
