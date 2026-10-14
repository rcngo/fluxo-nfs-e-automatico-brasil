-- Dados de teste da PoC. NFE.io em ambiente Development (sem validade fiscal).
-- Pode rodar mais de uma vez (ON CONFLICT DO NOTHING).
INSERT INTO prestadores (id, cnpj, razao_social, nfeio_company_id, municipio_ibge, valor_min_centavos, valor_max_centavos, exige_confirmacao)
-- nfeio_company_id fictício: troque pelo ID da sua empresa de testes na NFE.io (painel → Empresas).
VALUES ('00000000-0000-0000-0000-000000000001', '82571297000100', 'MODELO E CIA DESENVOLVIMENTO DE SISTEMAS LTDA',
        '00000000000000000000000000000000', '5205109', 10000, 5000000, true)
ON CONFLICT DO NOTHING;

-- Caixa que RECEBE os pedidos (Gmail do n8n): pedidos.exemplo@gmail.com.
-- Remetente autorizado: quem ENVIA os pedidos de teste.
INSERT INTO prestador_remetentes (prestador_id, canal, identificador, nome)
VALUES ('00000000-0000-0000-0000-000000000001', 'email', 'cliente.exemplo@hotmail.com', 'Titular')
ON CONFLICT DO NOTHING;

-- prestador_servicos não tem chave natural única: evita duplicar pelo apelido.
INSERT INTO prestador_servicos (prestador_id, apelido, descricao_padrao, city_service_code, federal_service_code, nbs_code)
SELECT '00000000-0000-0000-0000-000000000001', 'programação', 'Serviço de Programador', '010201', '010201', '115021000'
WHERE NOT EXISTS (
  SELECT 1 FROM prestador_servicos
  WHERE prestador_id = '00000000-0000-0000-0000-000000000001' AND apelido = 'programação'
);

INSERT INTO tomadores (prestador_id, documento, nome, endereco, situacao_cadastral, natureza_juridica, consultado_em)
VALUES ('00000000-0000-0000-0000-000000000001', '75768426000199', 'AGRO EXEMPLO COMERCIO LTDA',
        '{"country":"BRA","postalCode":"80010000","street":"Rua das Flores","number":"100","additionalInformation":"Sala 1","district":"Centro","city":{"code":"4106902","name":"Curitiba"},"state":"PR"}',
        'ATIVA', '2062', now())
-- Banco criado antes da E3: completa a natureza jurídica (Sociedade Empresária Limitada).
ON CONFLICT (prestador_id, documento) DO UPDATE SET natureza_juridica = EXCLUDED.natureza_juridica
  WHERE tomadores.natureza_juridica IS NULL;

-- Colaborador padrão: recebe os pedidos que a aplicação não consegue emitir.
-- Na PoC, a própria caixa que recebe os pedidos.
INSERT INTO colaboradores (nome, email, padrao)
VALUES ('Caixa da PoC (Modelo e Cia)', 'pedidos.exemplo@gmail.com', true)
ON CONFLICT DO NOTHING;
