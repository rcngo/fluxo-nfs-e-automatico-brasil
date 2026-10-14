# Cenários

Cada arquivo `.yaml` descreve uma conversa de exemplo e o que o sistema deve fazer. O comando `npm run cenarios` executa todos contra o motor real, com NFE.io, IA, Receita e relógio falsos (sem internet e sem emitir nada).

Os cenários são a **especificação** do comportamento: se o texto de um cenário não descreve o que o escritório espera, o cenário (e depois o código) é que deve mudar.

## Rodar

```bash
docker compose -f infra/docker-compose.yml up -d postgres
npm run cenarios                                  # todos
npm run cenarios -- confirmacao                   # só arquivos com "confirmacao" no caminho
npm run cenarios -- tributario                    # a pasta cenarios/tributario
npm run cenario -- cenarios/falta-cnpj-cliente-completa.yaml   # um, mostrando a conversa
```

## Formato

```yaml
nome: Frase que descreve o comportamento
dado:                       # opcional: situação inicial
  hoje: 2026-10-15          # data do "relógio" (padrão: 2026-10-15 10:00, horário de Brasília)
  empresa:                  # altera a empresa de teste (seed db/seeds/poc.sql)
    exige_confirmacao: false
    valor_max_centavos: 100000
  servico:                  # altera o serviço "programação" da empresa de teste
    pode_ter_retencao: [pj] # pf, pj, orgao_publico
    iss_pode_ser_devido_fora: true
  emissao_habilitada: false # botão de desligar a emissão
  nfeio: rejeita            # sucesso (padrão) | rejeita | demora | indisponivel | falha_envio | falha_apos_criar
                            # ou uma lista, um item por envio: [indisponivel, sucesso] (o último se repete)
  nfeio_consulta: fora      # a consulta da nota pela referência do pedido também não responde
  receita: fora             # a consulta de CNPJ (BrasilAPI) não responde
  historico:                # pedidos anteriores (ex.: para testar duplicidade)
    - { tomador: "75768426000199", valor: 350000, estado: ENTREGUE, ha: 2h }
  outras_empresas:          # outras empresas que o mesmo remetente pode representar
    - { cnpj: "81452590000195", razao_social: "AURORA SERVICOS DIGITAIS LTDA", exige_confirmacao: false }
  tomadores:                # tomadores cadastrados (como vindos da planilha: sem endereço)
    - { documento: "52998224725", nome: "FULANO DE TAL" }
    - { documento: "75768426000199", nome: "AGRO EXEMPLO", consultado_antes_da_e3: true }   # com endereço, sem natureza jurídica
  colaboradores:            # além do padrão do seed (pedidos.exemplo@gmail.com)
    - { nome: "Ana", email: "ana@escritorio.com.br", padrao: false }
  empresa: { colaborador: "ana@escritorio.com.br" }   # responsável pela empresa de teste
  sem_colaboradores: true   # apaga todos os colaboradores
  config: { prazo_resposta_dias_uteis: 1, max_rodadas_perguntas: 3, email_somente_remetentes_cadastrados: false }
passos:
  - cliente: "texto da mensagem"
  - cliente: { texto: "…", de: "outro@email.com", autenticado: false, id: "msg-x", ia: { … } }
  - cliente: { eml: pedido-completo.eml }       # e-mail de verdade (cenarios/emails/), pelo mesmo caminho do n8n
  - mensagem_do_cliente_registrada: "texto"      # o que foi gravado da última mensagem (sem o histórico citado)
  - nenhum_pedido: true                          # nada foi gravado (e-mail ignorado)
  - sistema_responde_contendo: "trecho"          # ou lista de trechos
  - sistema_nao_responde: true
  - estado: AGUARDANDO_CLIENTE
  - motivo_contendo: "fora da faixa"
  - notas_emitidas: 1
  - nota_emitida: { valor: 350000, tomador: "75768426000199", empresa: "82571297000100", competencia: "2026-09" }
  - payload_sem_impostos: true                   # o que foi à NFE.io não tem campo de imposto
  - sistema_entrega: [pdf, xml]
  - canal_confirma_entrega: true                 # o n8n avisa que entregou a nota
  - passa_tempo: 3d                              # 30m, 2h, 3d; roda as tarefas periódicas
  - nfeio_conclui: true                          # notas "demoradas" terminam de emitir
  - escritorio_configura: { emissao_habilitada: false }   # muda a configuração no meio da conversa
  - encaminhado_ao_colaborador:                  # mensagem ao colaborador
      motivo: cliente_nao_respondeu              # código de motor/encaminhamento.js
      para: pedidos.exemplo@gmail.com                 # null = sem colaborador cadastrado
      contendo: ["trecho do assunto ou do texto"]
  - nada_encaminhado: true
  - colaborador_resolve: { numero_nota: "1234" } # abre o link e clica em "Marcar como resolvido"
  - colaborador_resolve: { esperado: ja_resolvido }
  - colaborador_resolve: { link: adulterado }    # deve ser recusado
```

### Dados de teste disponíveis

- Empresa: MODELO E CIA (seed), remetente autorizado `cliente.exemplo@hotmail.com`, serviço "programação", faixa de R$ 100,00 a R$ 50.000,00, exige confirmação.
- Receita falsa: `75768426000199` Agro Exemplo (ativa), `74865958000181` Empresa Teste (ativa), `74964367000161` Empresa Baixada (baixada), `73479394000186` Município de Exemplo (órgão público, natureza jurídica 1244). Outros CNPJs: não encontrados.

### A IA nos cenários

A IA é substituída por um extrator falso (`motor/falsos/extrator.js`) que reconhece CNPJ/CPF, "R$ valor", mês por extenso, o apelido do serviço, SIM/NÃO, frases de instrução ao sistema, valor líquido ("líquido", "quero receber"), tomador no exterior ("exterior", "Estados Unidos"…) e menção a imposto ("retenção", "ISS", "INSS"…). Para simular o que ele não cobre, use `ia:` no passo do cliente:

```yaml
  - cliente: { texto: "nota de 3,5 pra Agro Exemplo", ia: { valor: { centavos: null, ambiguo: true } } }
  - cliente: { texto: "…", ia: { falha: true } }     # a IA falha
```

A qualidade da extração real é medida separadamente, com o Claude, em `avaliacao/`.

### Autoteste

`_autoteste/passo-errado.yaml` tem `deve_falhar: true`: ele precisa falhar. Se um dia passar, o executor parou de detectar erros.
