-- E2: encaminhamento ao colaborador quando a aplicação não consegue emitir.

-- ENCAMINHADO: está com o colaborador. RESOLVIDO_MANUAL: o colaborador marcou como resolvido.
ALTER TYPE estado_pedido ADD VALUE IF NOT EXISTS 'ENCAMINHADO';
ALTER TYPE estado_pedido ADD VALUE IF NOT EXISTS 'RESOLVIDO_MANUAL';

-- Quantas perguntas de dados já foram feitas (depois do limite, encaminha).
ALTER TABLE pedidos ADD COLUMN rodadas_perguntas integer NOT NULL DEFAULT 0;

-- Cada mensagem enviada ao colaborador (o encaminhamento e as atualizações do mesmo pedido).
CREATE TABLE encaminhamentos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id      uuid NOT NULL REFERENCES pedidos(id),
  motivo         text NOT NULL,          -- código (motor/encaminhamento.js)
  detalhe        text,
  colaborador_id uuid REFERENCES colaboradores(id),
  para_email     text,                   -- null = nenhum colaborador cadastrado
  para_whatsapp  text,
  assunto        text NOT NULL,
  texto          text NOT NULL,
  -- Link "Resolvido": guarda só o hash do token; o token vai no e-mail.
  token_hash     text NOT NULL UNIQUE,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  resolvido_em   timestamptz,
  resolvido_por  text,
  numero_nota    text,                   -- nota emitida pelo colaborador fora do sistema (opcional)
  observacao     text
);
CREATE INDEX ON encaminhamentos (pedido_id);

-- Prazos (editáveis no painel a partir da E8).
INSERT INTO config VALUES
  ('prazo_resposta_dias_uteis', '2'),
  ('max_rodadas_perguntas', '2')
ON CONFLICT (chave) DO NOTHING;
