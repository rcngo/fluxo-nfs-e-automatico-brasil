# NFS-e automática para escritórios contábeis

O cliente do escritório pede a nota por e-mail ou WhatsApp. A aplicação verifica o pedido e **emite** quando está tudo certo, **pergunta** ao cliente o que falta e, quando não consegue resolver, **encaminha** ao colaborador do escritório.

- Instalação: `docs/INSTALACAO.md`; operação: `docs/RUNBOOK.md`.

## Regras fixas (valem para qualquer mudança)

1. **Nunca emitir NFS-e real** sem a liberação formal do escritório. A trava de ambiente (`motor/nfeio.js`) só permite emitir em `Development`; `Production` só com `EMISSAO_PRODUCAO_HABILITADA=true` **e** `EMISSAO_PRODUCAO_DECISAO` preenchida no `.env` da instalação do escritório, definidos pelo escritório (nunca pelo agente). Testes e cenários usam a NFE.io falsa (`motor/falsos`).
2. **A IA só extrai.** Ela nunca emite, nunca responde ao cliente e nunca decide; quem decide é o código (`n8n/decidir.js`).
3. **O produto não calcula imposto.** No caso comum, nenhum campo de imposto vai no payload (a NFE.io calcula o ISS). Caso tributário especial é encaminhado ao colaborador.
4. **Na dúvida, pergunta; se não conseguir, encaminha.** Nunca emitir com dado presumido. Todo caso que o sistema não resolve vira `encaminhar` com um motivo de `motor/encaminhamento.js` — nunca uma mensagem ao cliente dizendo que o escritório foi avisado sem que ele seja.
5. **Toda chamada externa** (NFE.io, Claude, BrasilAPI, Gmail, WhatsApp) chega ao motor como dependência (`criarMotor` em `motor/app.js`) e tem versão falsa. Testes e cenários nunca acessam serviço real.
6. **Segredos fora do git** (`infra/.env`, `infra/secrets.env`). Dados reais de clientes (PDFs, casos reais) também ficam fora.
7. **Docker Compose com `name: nfs-poc`**: nesta máquina há outros projetos em pastas `infra`; não mexer em containers de outros projetos. Postgres em `127.0.0.1:5433`. O compose de produção (`infra/producao`, `name: nfs`) só sobe nesta máquina para teste com `COMPOSE_PROJECT_NAME=nfs-e9-teste` e portas trocadas (`HTTP_PORTA`, `HTTPS_PORTA`, `N8N_PORTA_LOCAL`).
8. **Dinheiro em centavos.** Toda mudança de estado do pedido gera evento (tabela `eventos`).

## Estrutura

| Caminho | O quê |
|---|---|
| `motor/app.js` | Lógica: processar mensagem, emitir, retomar pendências (recebe as dependências por parâmetro) |
| `motor/server.js` | Ligação com os serviços reais; o servidor HTTP fica em `motor/http.js` (rotas do n8n, `/resolvido`, `/painel`) |
| `motor/painel.js` | Painel do escritório (login, pedidos, cadastros, configurações); HTML em `motor/painel-html.js` |
| `motor/encaminhamento.js` | Motivos de encaminhamento e texto da mensagem ao colaborador |
| `motor/prazos.js` | Prazo de resposta em dias úteis |
| `motor/paginas.js` | Páginas HTML do link "Resolvido" |
| `motor/empresa.js` | Escolha da empresa quando o remetente pode pedir para mais de uma (sem IA) |
| `motor/email.js` | E-mail recebido: autenticação (cabeçalho do Gmail, domínio alinhado) e texto sem o histórico citado |
| `motor/whatsapp.js` | WhatsApp (Cloud API): assinatura do webhook, mensagens recebidas, janela de 24 h e modelo |
| `motor/falsos/` | NFE.io, extrator (IA), BrasilAPI e relógio falsos |
| `n8n/decidir.js` | Regras determinísticas de decisão |
| `n8n/extrair.js` | Chamada ao Claude (prompt em `prompts/`, schema em `schemas/`) |
| `n8n/workflows/` | Workflows do n8n (só transportam mensagens; sem regra de negócio) |
| `db/migracoes/` | Migrações numeradas (`NNN_nome.sql`); nunca editar uma já aplicada, criar a próxima |
| `db/seeds/` | Dados de teste da PoC (só desenvolvimento) |
| `cenarios/` | Cenários executáveis — especificação viva do comportamento (formato em `cenarios/README.md`) |
| `scripts/importar.js` | Importação de cadastros por planilha CSV (modelo em `docs/modelo-cadastro/`) |
| `avaliacao/` | Avaliação da extração com o Claude real |
| `infra/producao/` | Instalação do escritório: compose (Caddy, backup), `instalar.sh`, `workflows.sh`, `backup.sh`, `restaurar.sh` |
| `docs/INSTALACAO.md`, `docs/RUNBOOK.md` | Guia de instalação e roteiro de operação (manter atualizados ao mudar a instalação) |

## Comandos

```bash
docker compose -f infra/docker-compose.yml up -d postgres   # necessário para os cenários
npm test                    # testes unitários
npm run cenarios            # todos os cenários (cria o banco nfs_cenarios do zero)
npm run cenario -- cenarios/arquivo.yaml   # um cenário, mostrando a conversa
npm run teste:painel        # painel pelo HTTP (banco nfs_painel)
npm run verificar           # testes + painel + cenários (roda no pre-commit)
npm run painel:senha -- <email>   # gera a senha de acesso ao painel de um colaborador
npm run db:migrar           # aplica migrações pendentes (DATABASE_URL)
npm run importar -- <pasta> --previa   # confere planilhas de cadastro (sem --previa grava)
npm run avaliar             # avaliação com o Claude real (custa tokens; precisa de infra/secrets.env)
npm run teste:externo -- nfeio   # emite 1 nota no simulador da NFE.io (trava de ambiente; precisa de infra/secrets.env)
node n8n/workflows/gerar_workflows.js --gmail <id> --alerta <email> [--whatsapp-cred <id> --whatsapp-numero <phone_number_id>]   # gera os workflows; importar com n8n import:workflow
```

Hook de pre-commit: `git config core.hooksPath .githooks` (uma vez por clone).

## Ao mudar comportamento

- Escrever ou ajustar o cenário **antes** do código; o cenário é a especificação que o usuário valida.
- Mudança de banco = nova migração em `db/migracoes/`.
- Mudança no prompt = nova versão (`VERSAO_PROMPT` em `n8n/extrair.js`) e rodar a avaliação.
