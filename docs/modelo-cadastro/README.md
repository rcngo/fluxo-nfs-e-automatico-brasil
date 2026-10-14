# Modelo de cadastro por planilha

Cinco planilhas, uma por tipo de cadastro. Todas são opcionais: dá para importar só as que mudaram. Os arquivos desta pasta têm dados **fictícios** de exemplo.

Como preencher: abra os arquivos no Excel ou no Google Planilhas, troque os exemplos pelos dados reais e salve/exporte cada aba como **CSV** com o mesmo nome. Separador `;` (padrão do Excel em português) ou `,`.

```bash
npm run importar -- caminho/da/pasta --previa   # confere tudo e mostra os erros, sem gravar
npm run importar -- caminho/da/pasta            # grava as linhas válidas
```

Importar de novo **atualiza** o que já existe (pela chave de cada planilha), não duplica.

## colaboradores.csv — quem recebe os pedidos que a aplicação não consegue emitir

| Coluna | Obrigatória | Exemplo | Observação |
|---|---|---|---|
| nome | sim | Maria Exemplo | |
| email | sim | maria@escritorio.com.br | chave |
| whatsapp | não | (64) 99999-0001 | DDD + número |
| padrao | não | sim | recebe os casos das empresas sem responsável; só um pode ser `sim` |

## empresas.csv — clientes do escritório que emitem a nota

| Coluna | Obrigatória | Exemplo | Observação |
|---|---|---|---|
| cnpj | sim | 98.765.432/0001-98 | chave |
| razao_social | sim | EXEMPLO CONSULTORIA LTDA | |
| nfeio_company_id | sim | (id da empresa na NFE.io) | |
| municipio_ibge | sim | 5205109 | código IBGE do município, 7 dígitos (5205109 = Catalão/GO) |
| valor_minimo | não | 100,00 | abaixo disso o pedido não é emitido automaticamente |
| valor_maximo | sim | 20.000,00 | acima disso o pedido não é emitido automaticamente |
| exige_confirmacao | não | sim | o cliente responde SIM antes da emissão (padrão: sim) |
| colaborador_email | não | joao@escritorio.com.br | responsável; precisa estar em colaboradores.csv ou já cadastrado |

## servicos.csv — serviços que cada empresa pode faturar

A IA só escolhe entre os serviços cadastrados. O **apelido** é como o cliente costuma chamar o serviço.

| Coluna | Obrigatória | Exemplo | Observação |
|---|---|---|---|
| empresa_cnpj | sim | 98.765.432/0001-98 | |
| apelido | sim | consultoria | chave junto com a empresa |
| descricao_padrao | sim | Serviço de consultoria empresarial | texto base da discriminação da nota |
| codigo_servico_municipal | sim | 170101 | `cityServiceCode` da NFE.io (no padrão nacional, igual ao código de tributação nacional) |
| codigo_tributacao_nacional | não | 170101 | cTribNac, 6 dígitos |
| nbs | não | 113040000 | 9 dígitos |
| retencao | não | PJ / órgão público | para quais tomadores o serviço **pode ter retenção** (PF, PJ, órgão público); vazio = nenhum. Marcado pelo contador |
| iss_fora_do_municipio | não | não | `sim` se o serviço está nas exceções da LC 116, art. 3º (ISS pode ser devido fora do município da empresa) |

Pedidos de serviço com retenção possível para aquele tipo de tomador, ou com ISS que pode ser devido fora, **não são emitidos automaticamente**: vão para o colaborador. Tomador órgão público vai sempre para o colaborador, mesmo sem marcação. Se a planilha não tiver as colunas `retencao` e `iss_fora_do_municipio`, a importação mantém o que já estava marcado.

## remetentes.csv — quem pode pedir nota em nome de cada empresa

Um mesmo e-mail ou telefone pode aparecer em várias empresas (sócio com mais de uma empresa): se o pedido não disser de qual empresa é, a aplicação pergunta.

| Coluna | Obrigatória | Exemplo | Observação |
|---|---|---|---|
| empresa_cnpj | sim | 98.765.432/0001-98 | |
| canal | sim | email | `email` ou `whatsapp` |
| identificador | sim | socio@empresa.com.br | e-mail, ou telefone com DDD |
| nome | não | Sócio | |

## tomadores.csv — clientes de cada empresa (opcional)

Não é obrigatório: quando o tomador não está cadastrado, a aplicação consulta o CNPJ na Receita. Cadastrar ajuda com tomadores pessoa física e com o e-mail do tomador.

| Coluna | Obrigatória | Exemplo | Observação |
|---|---|---|---|
| empresa_cnpj | sim | 98.765.432/0001-98 | |
| documento | sim | 74.865.958/0001-81 | CNPJ ou CPF; chave junto com a empresa |
| nome | sim | EMPRESA TESTE LTDA | |
| email | não | financeiro@empresateste.com.br | |
