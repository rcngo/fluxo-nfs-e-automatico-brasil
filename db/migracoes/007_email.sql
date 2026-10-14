-- E5: e-mail de ponta a ponta.

-- Caixa de e-mail compartilhada (a do escritório): e-mail de quem não é remetente cadastrado
-- é ignorado sem gravar nada (fica na caixa para o atendimento normal). Com false, vira
-- encaminhamento "remetente não autorizado" (bom para uma caixa dedicada aos pedidos).
INSERT INTO config VALUES ('email_somente_remetentes_cadastrados', 'true') ON CONFLICT (chave) DO NOTHING;

-- Quando o n8n confirmou o envio da mensagem ao colaborador.
ALTER TABLE encaminhamentos ADD COLUMN enviado_em timestamptz;

-- Erros do n8n (workflow de erro) não pertencem a um pedido: eventos.pedido_id já aceita null.
