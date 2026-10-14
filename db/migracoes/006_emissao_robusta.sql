-- E4: novas tentativas de emissão quando a NFE.io está indisponível.

-- Quando a primeira tentativa falhou (o prazo para encaminhar conta daqui), quantas foram
-- feitas e quando é a próxima.
ALTER TABLE pedidos ADD COLUMN emissor_desde timestamptz;
ALTER TABLE pedidos ADD COLUMN emissor_tentativas integer NOT NULL DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN proxima_tentativa_em timestamptz;
-- O envio pode ter chegado à NFE.io (conexão caiu depois do envio): antes de qualquer nova
-- tentativa, consultar a nota pela referência do pedido (externalId = pedidos.id).
ALTER TABLE pedidos ADD COLUMN emissao_incerta boolean NOT NULL DEFAULT false;

-- Pedido esperando o emissor continua "em aberto": a próxima mensagem da conversa cai nele.
DROP INDEX pedidos_um_aberto_por_conversa;
CREATE UNIQUE INDEX pedidos_um_aberto_por_conversa
  ON pedidos (canal, conversa_ref)
  WHERE estado IN ('RECEBIDO', 'AGUARDANDO_CLIENTE', 'AGUARDANDO_CONFIRMACAO', 'VALIDADO', 'EMITINDO', 'AGUARDANDO_EMISSOR');

CREATE INDEX pedidos_aguardando_emissor ON pedidos (proxima_tentativa_em) WHERE estado = 'AGUARDANDO_EMISSOR';

-- Depois deste prazo sem conseguir emitir, o pedido vai para o colaborador.
INSERT INTO config VALUES ('prazo_emissor_horas', '4') ON CONFLICT (chave) DO NOTHING;
