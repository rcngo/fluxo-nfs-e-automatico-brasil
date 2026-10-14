-- E3: casos tributários especiais. O produto não calcula imposto: estes campos só servem
-- para encaminhar ao colaborador os pedidos em que o cálculo automático da NFE.io não basta.

-- Tipos de tomador para os quais o serviço pode ter retenção (marcado pelo contador):
-- 'pf' (pessoa física), 'pj' (pessoa jurídica), 'orgao_publico'.
ALTER TABLE prestador_servicos ADD COLUMN pode_ter_retencao text[] NOT NULL DEFAULT '{}'
  CHECK (pode_ter_retencao <@ ARRAY['pf', 'pj', 'orgao_publico']::text[]);

-- Serviço das exceções da LC 116/2003, art. 3º: o ISS pode ser devido no município do
-- tomador ou do local da prestação, e não no do prestador.
ALTER TABLE prestador_servicos ADD COLUMN iss_pode_ser_devido_fora boolean NOT NULL DEFAULT false;

-- Natureza jurídica da Receita (ex.: '1015' = Órgão Público do Poder Executivo Federal).
-- Códigos 1xxx = administração pública.
ALTER TABLE tomadores ADD COLUMN natureza_juridica text;
