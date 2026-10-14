-- E8: painel do escritório (login dos colaboradores).

-- Senha do colaborador: "scrypt$<N>$<sal base64>$<hash base64>" (motor/senha.js). Sem senha, não entra.
ALTER TABLE colaboradores ADD COLUMN senha_hash text;

-- Sessões do painel. O cookie leva o token; aqui fica só o hash.
CREATE TABLE sessoes (
  token_hash     text PRIMARY KEY,
  colaborador_id uuid NOT NULL REFERENCES colaboradores(id),
  csrf           text NOT NULL,          -- vai em todo formulário do painel
  criado_em      timestamptz NOT NULL DEFAULT now(),
  expira_em      timestamptz NOT NULL
);
CREATE INDEX ON sessoes (expira_em);

-- Lista de pedidos do painel (filtro por período e estado).
CREATE INDEX IF NOT EXISTS pedidos_criado_em ON pedidos (criado_em DESC);
