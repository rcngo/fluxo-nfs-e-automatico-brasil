# Nó HTTP Request — extração com Claude

- **Método/URL:** `POST https://api.anthropic.com/v1/messages`
- **Credencial (Header Auth):** `x-api-key: <ANTHROPIC_API_KEY>`
- **Headers:**
  - `anthropic-version: 2023-06-01`
  - `anthropic-beta: server-side-fallback-2026-07-01` (se o modelo recusar, a API refaz a chamada em outro modelo automaticamente)
  - `content-type: application/json`
- **Timeout:** 60 s, com 2 retentativas só para 429/5xx.

## Body (JSON)

O nó Code anterior monta `system_prompt` (conteúdo de `prompts/extracao_system.md`, **sem alterar byte algum** para o cache funcionar), `user_prompt` (a partir de `prompts/extracao_user_template.md`) e `schema` (`schemas/extracao.schema.json`).

```json
{
  "model": "claude-opus-5",
  "max_tokens": 4000,
  "fallbacks": "default",
  "output_config": {
    "effort": "low",
    "format": { "type": "json_schema", "schema": {{ $json.schema }} }
  },
  "system": [
    {
      "type": "text",
      "text": {{ JSON.stringify($json.system_prompt) }},
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    { "role": "user", "content": {{ JSON.stringify($json.user_prompt) }} }
  ]
}
```

## Tratamento da resposta (nó Code seguinte)

1. `stop_reason === "end_turn"` → `JSON.parse(content.find(b => b.type === "text").text)`.
2. `stop_reason === "max_tokens"` ou `"refusal"` → tratar como falha de extração: evento `erro`, pedido segue para pergunta genérica ao cliente ("não consegui entender o pedido, pode reenviar com CNPJ, valor e serviço?"). **Nunca** emitir.
3. Gravar em `eventos`: `modelo` (campo `model` da resposta, que muda se houve fallback), `versao_prompt` (o valor de `VERSAO_PROMPT` em `n8n/extrair.js`), `usage` (tokens e `cache_read_input_tokens` para conferir o cache).

## Modelo

Padrão `claude-opus-5` com `effort: low`. A extração é curta, então o custo por pedido fica na casa de centavos de dólar. Depois de montar o conjunto de avaliação (`avaliacao/`), vale comparar com `claude-sonnet-5` e `claude-haiku-4-5`: se o acerto for igual, troca-se o modelo para baratear. Isso é decisão de custo de vocês.

> Observação: com o Haiku 4.5, o prompt de sistema só entra em cache acima de 4.096 tokens (o nosso é menor), e o campo `effort` não é aceito; remova `effort` do body se trocar para ele.
