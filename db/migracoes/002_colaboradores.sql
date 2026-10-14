-- E1: colaboradores do escritório (recebem os pedidos encaminhados a partir da E2)
-- e chave natural dos serviços (para a importação por planilha atualizar em vez de duplicar).

CREATE TABLE colaboradores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL,
  email      text NOT NULL UNIQUE,           -- minúsculas
  whatsapp   text,                           -- E.164 (+5564...), opcional
  -- Recebe os encaminhamentos das empresas sem responsável definido.
  padrao     boolean NOT NULL DEFAULT false,
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
-- No máximo um colaborador padrão.
CREATE UNIQUE INDEX colaboradores_um_padrao ON colaboradores (padrao) WHERE padrao;

-- Responsável por cada empresa (prestador).
ALTER TABLE prestadores ADD COLUMN colaborador_id uuid REFERENCES colaboradores(id);

-- Um apelido por serviço dentro da mesma empresa.
CREATE UNIQUE INDEX prestador_servicos_apelido ON prestador_servicos (prestador_id, apelido);

-- Observação: prestador_remetentes já permite o mesmo remetente em várias empresas
-- (UNIQUE (prestador_id, canal, identificador)); a E1 só muda o comportamento do motor.
