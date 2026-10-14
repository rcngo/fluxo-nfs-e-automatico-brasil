-- Banco da aplicação (nfs). Valores monetários sempre em centavos (bigint).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Cadastros (mantidos pelo escritório)
-- ---------------------------------------------------------------------------

CREATE TABLE prestadores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj                char(14) NOT NULL UNIQUE,
  razao_social        text NOT NULL,
  nfeio_company_id    text NOT NULL,             -- id da empresa na NFE.io
  municipio_ibge      char(7) NOT NULL,
  valor_min_centavos  bigint NOT NULL DEFAULT 1,
  valor_max_centavos  bigint NOT NULL,           -- acima disso o pedido é recusado
  -- Decisão 4: o cliente responde "SIM" antes da emissão. Configurável por prestador.
  exige_confirmacao   boolean NOT NULL DEFAULT true,
  ativo               boolean NOT NULL DEFAULT true,
  criado_em           timestamptz NOT NULL DEFAULT now()
);

-- Quem pode pedir nota em nome de cada prestador.
CREATE TABLE prestador_remetentes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prestador_id    uuid NOT NULL REFERENCES prestadores(id),
  canal           text NOT NULL CHECK (canal IN ('email', 'whatsapp')),
  identificador   text NOT NULL,  -- e-mail em minúsculas ou telefone E.164 (+5511...)
  nome            text,
  ativo           boolean NOT NULL DEFAULT true,
  UNIQUE (prestador_id, canal, identificador)
);
CREATE INDEX ON prestador_remetentes (canal, identificador) WHERE ativo;

-- Serviços que o prestador pode faturar. O LLM só escolhe entre estes.
CREATE TABLE prestador_servicos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prestador_id          uuid NOT NULL REFERENCES prestadores(id),
  apelido               text NOT NULL,           -- ex.: "consultoria mensal"
  descricao_padrao      text NOT NULL,           -- texto base da discriminação
  -- Padrão nacional (ex.: Catalão/GO): o município não tem código próprio;
  -- vale o código de tributação nacional (cTribNac, 6 dígitos) + NBS.
  city_service_code     text NOT NULL,           -- cityServiceCode da NFE.io
  federal_service_code  text,                    -- federalServiceCode = cTribNac (ex.: 010201)
  nbs_code              text,                    -- ex.: 115021000
  ativo                 boolean NOT NULL DEFAULT true
);

-- Tomadores já conhecidos (acelera e dá o endereço exigido pela NFE.io).
CREATE TABLE tomadores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prestador_id        uuid NOT NULL REFERENCES prestadores(id),
  documento           varchar(14) NOT NULL,      -- CNPJ (14) ou CPF (11), só dígitos
  nome                text NOT NULL,
  email               text,
  endereco            jsonb,                     -- formato do "borrower.address" da NFE.io
  situacao_cadastral  text,
  consultado_em       timestamptz,
  UNIQUE (prestador_id, documento)
);

-- ---------------------------------------------------------------------------
-- Pedidos e máquina de estados
-- ---------------------------------------------------------------------------

CREATE TYPE estado_pedido AS ENUM (
  'RECEBIDO',
  'AGUARDANDO_CLIENTE',       -- falta dado; pergunta enviada
  'AGUARDANDO_CONFIRMACAO',   -- resumo enviado; esperando "SIM"
  'VALIDADO',
  'EMITINDO',                 -- POST enviado à NFE.io; aguardando retorno
  'EMITIDA',
  'ENTREGUE',
  'RECUSADO',                 -- bloqueante (remetente não autorizado, fora de faixa etc.)
  'ERRO_EMISSAO',
  'EXPIRADO',
  'CANCELADO'                 -- cliente respondeu "NÃO" ou pediu cancelamento
);

CREATE TABLE pedidos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal               text NOT NULL CHECK (canal IN ('email', 'whatsapp')),
  remetente           text NOT NULL,
  -- Chave da conversa: threadId do Gmail ou telefone no WhatsApp.
  conversa_ref        text NOT NULL,
  prestador_id        uuid REFERENCES prestadores(id),
  estado              estado_pedido NOT NULL DEFAULT 'RECEBIDO',
  dados               jsonb,          -- último JSON consolidado (extração + resolução em código)
  faltantes           text[] NOT NULL DEFAULT '{}',
  motivo              text,           -- motivo de recusa/erro, legível
  nfeio_invoice_id    text UNIQUE,    -- gravado ANTES de qualquer nova tentativa
  valor_centavos      bigint,         -- desnormalizado para a checagem de duplicidade
  tomador_documento   varchar(14),
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  expira_em           timestamptz NOT NULL DEFAULT now() + interval '3 days'
);

-- No máximo um pedido "em aberto" por conversa: a resposta do cliente cai nele.
CREATE UNIQUE INDEX pedidos_um_aberto_por_conversa
  ON pedidos (canal, conversa_ref)
  WHERE estado IN ('RECEBIDO', 'AGUARDANDO_CLIENTE', 'AGUARDANDO_CONFIRMACAO', 'VALIDADO', 'EMITINDO');

-- Checagem de duplicidade (mesmo prestador, tomador e valor em 24h).
CREATE INDEX pedidos_duplicidade
  ON pedidos (prestador_id, tomador_documento, valor_centavos, criado_em);

-- Toda mensagem recebida ou enviada. message_id único = idempotência na ingestão.
CREATE TABLE mensagens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id     uuid REFERENCES pedidos(id),
  direcao       text NOT NULL CHECK (direcao IN ('entrada', 'saida')),
  canal         text NOT NULL,
  message_id    text NOT NULL,        -- Message-ID do e-mail ou wamid do WhatsApp
  conteudo      text NOT NULL,
  metadados     jsonb,                -- cabeçalhos, resultado SPF/DKIM, anexos
  criado_em     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canal, message_id)
);

-- Log auditável: cada extração, validação, decisão e chamada externa.
CREATE TABLE eventos (
  id            bigserial PRIMARY KEY,
  pedido_id     uuid REFERENCES pedidos(id),
  tipo          text NOT NULL,        -- extracao | validacao | decisao | emissao | webhook | entrega | erro
  estado_de     estado_pedido,
  estado_para   estado_pedido,
  detalhe       jsonb NOT NULL DEFAULT '{}',
  modelo        text,                 -- ex.: claude-opus-5
  versao_prompt text,                 -- ex.: extracao-v1
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON eventos (pedido_id, criado_em);

-- Botão de desligar: o WF3 checa antes de emitir.
CREATE TABLE config (
  chave  text PRIMARY KEY,
  valor  jsonb NOT NULL
);
INSERT INTO config VALUES ('emissao_habilitada', 'true');
