-- E4: a NFE.io (ou a prefeitura) está fora do ar; o pedido espera novas tentativas.
-- Separada da 006 porque o valor novo do enum não pode ser usado na mesma transação.
ALTER TYPE estado_pedido ADD VALUE IF NOT EXISTS 'AGUARDANDO_EMISSOR';
