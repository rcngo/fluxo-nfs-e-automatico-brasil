# NFS-e automática para escritórios contábeis

[![testes](https://github.com/rcngo/fluxo-nfs-e-automatico-brasil/actions/workflows/testes.yml/badge.svg)](https://github.com/rcngo/fluxo-nfs-e-automatico-brasil/actions/workflows/testes.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Os clientes do escritório pedem a nota fiscal de serviço por **e-mail** ou **WhatsApp**, do jeito que já pedem hoje ("Preciso de uma nota de R$ 3.500 para a empresa X, referente a setembro"). A aplicação lê o pedido e faz uma de três coisas:

| Situação | O que a aplicação faz |
|---|---|
| Está tudo certo | **emite** a nota pela NFE.io e manda o PDF e o XML ao cliente, na mesma conversa |
| Falta alguma informação (CNPJ, valor, mês...) | **pergunta** ao cliente o que falta |
| Não consegue resolver sozinha (caso tributário, pedido estranho, cliente não respondeu) | **encaminha** ao colaborador do escritório, explicando o motivo |

Os colaboradores acompanham tudo por um **painel** no navegador: pedidos, notas emitidas, encaminhamentos, cadastros e configurações.

### Regras de segurança da aplicação

- **A IA só lê o pedido.** Quem decide se emite, pergunta ou encaminha são regras fixas no código, testadas uma a uma.
- **A aplicação não calcula imposto.** A NFE.io calcula o ISS pela configuração de cada empresa. Retenção, órgão público e outros casos especiais vão sempre para o colaborador.
- **Na dúvida, a aplicação pergunta; se não conseguir, encaminha.** Nunca emite com dado presumido.
- **Notas reais só com a decisão formal do escritório.** Até lá, a aplicação só consegue emitir no ambiente de testes da NFE.io (há uma trava no código).

---

## Como funciona

```
 Cliente ──e-mail──►  Gmail ───┐
 Cliente ─WhatsApp─►  Meta ────┤
                               ▼
                         n8n ("carteiro": busca, recebe e envia as mensagens)
                               │
                               ▼
                    motor (as regras: lê com a IA, confere, decide)
                     │          │            │
              Anthropic      NFE.io      BrasilAPI
            (lê o pedido) (emite a nota) (confere o CNPJ)
                               │
                       Postgres (pedidos, cadastros, histórico)
                               │
                  Painel do escritório (navegador)
```

| Peça | O que é |
|---|---|
| **motor** | o programa principal (Node.js): as regras, a conversa com a IA e com a NFE.io, e o painel |
| **n8n** | ferramenta de automação que leva as mensagens entre o Gmail/WhatsApp e o motor |
| **Postgres** | o banco de dados |
| **Caddy** | (só no servidor) dá o endereço com HTTPS e deixa aberto na internet só o necessário |
| **Docker** | roda tudo isso em "caixinhas" (containers), sem instalar cada peça à mão |

---

## Contas e chaves necessárias

| Conta | Para quê | Onde |
|---|---|---|
| **Anthropic** (chave da API) | a IA que lê os pedidos | https://console.anthropic.com → API Keys |
| **NFE.io** (chave da API) | emitir as notas | https://app.nfe.io → Conta → Chaves de acesso |
| **Google** (Gmail ou Workspace) | a caixa que recebe os pedidos | conta do escritório |
| **Meta / WhatsApp Business** *(opcional)* | atendimento por WhatsApp | https://developers.facebook.com |

---

## Escolha o seu caso

- **[A. Instalar no servidor do escritório](#a-instalar-no-servidor-do-escritório)**: para colocar em uso de verdade.
- **[B. Rodar no seu computador](#b-rodar-no-seu-computador-testes-e-desenvolvimento)**: para conhecer, testar ou desenvolver.

---

## A. Instalar no servidor do escritório

O passo a passo completo, dizendo onde clicar em cada serviço, está em **[docs/INSTALACAO.md](docs/INSTALACAO.md)**. Em resumo:

**1. Prepare um servidor Linux** (Ubuntu 24.04, 2 vCPU, 4 GB de RAM) com o Docker:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # depois saia e entre de novo no SSH
```

**2. Aponte um domínio para o servidor**, por exemplo `nfs.seuescritorio.com.br` (registro DNS do tipo A com o IP do servidor).

**3. Copie a aplicação e rode o instalador:**

```bash
git clone https://github.com/rcngo/fluxo-nfs-e-automatico-brasil.git ~/nfs
cd ~/nfs/infra/producao
./instalar.sh
```

O instalador pergunta o domínio, as chaves da Anthropic e da NFE.io e o primeiro colaborador. Ele gera as senhas internas, sobe tudo e mostra a **senha do painel**. Anote: ela aparece só uma vez.

**4. Abra o painel:** `https://<seu domínio>/painel`

**5. Conecte o Gmail no n8n e importe os workflows.** O editor do n8n é aberto por um túnel SSH, porque não fica exposto na internet:

```bash
# no SEU computador, deixe rodando:
ssh -N -L 5678:127.0.0.1:5678 usuario@servidor
# abra http://localhost:5678, crie a conta do n8n e a credencial do Gmail (passo 6 do guia)

# no servidor:
./workflows.sh --gmail <ID da credencial> --alerta <e-mail para alertas>
# no n8n, ligue o workflow "NFS - E-mail"
```

**6. Cadastre** as empresas, os serviços e quem pode pedir nota, pelo painel ou por planilha ([modelo](docs/modelo-cadastro/README.md)).

**7. Guarde o `.env` e o `secrets.env`** (pasta `infra/producao`) no cofre de senhas do escritório.

O **backup** roda sozinho todo dia às 02:30. Cada backup é testado (restaurado numa base temporária) e o painel avisa se algum falhar. O que fazer quando algo dá errado (sistema fora do ar, nota errada, desligar a emissão, restaurar backup, ligar as notas reais) está em **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

---

## B. Rodar no seu computador (testes e desenvolvimento)

Aqui a aplicação roda com **dados de teste** e nunca emite nota real.

### 1. Instale os programas

| Programa | Para quê | Onde |
|---|---|---|
| **Docker Desktop** | rodar o banco e o n8n | https://www.docker.com/products/docker-desktop |
| **Node.js 24** | rodar os testes e os scripts | https://nodejs.org |
| **Git** | baixar o código | https://git-scm.com |

Confira no terminal:

```bash
docker --version && node --version && git --version
```

### 2. Baixe o código e instale as dependências

```bash
git clone https://github.com/rcngo/fluxo-nfs-e-automatico-brasil.git nfs-automatica
cd nfs-automatica
npm install
git config core.hooksPath .githooks     # roda os testes antes de cada commit
```

### 3. Configure

```bash
cp infra/.env.example infra/.env
cp infra/secrets.env.example infra/secrets.env
```

Abra os dois arquivos num editor de texto e preencha:
- em `infra/.env`: uma senha qualquer em `POSTGRES_PASSWORD` e, em `N8N_ENCRYPTION_KEY`, o resultado do comando `openssl rand -hex 32`;
- em `infra/secrets.env`: as chaves da Anthropic e da NFE.io (conta de testes).

Esses dois arquivos **nunca vão para o git**: eles têm senhas.

### 4. Suba os serviços

```bash
docker compose -f infra/docker-compose.yml up -d
```

Na primeira vez, o motor cria as tabelas e carrega **dados de teste** (uma empresa, serviços e um colaborador). Ficam no ar:

| O quê | Endereço |
|---|---|
| Painel | http://localhost:3010/painel |
| n8n | http://localhost:5678 |
| Banco (Postgres) | `127.0.0.1:5433` |

### 5. Entre no painel

```bash
npm run painel:senha -- pedidos.exemplo@gmail.com    # colaborador dos dados de teste
```

Use a senha mostrada para entrar em http://localhost:3010/painel.

### 6. Rode os testes (não gastam nada, não acessam serviço real)

```bash
npm run verificar      # testes + painel + cenários; deve terminar com "0 falha(s)"
```

| Comando | O quê |
|---|---|
| `npm test` | testes unitários |
| `npm run cenarios` | todos os cenários: conversas completas com NFE.io, IA e Receita falsas |
| `npm run cenario -- cenarios/<arquivo>.yaml` | um cenário, mostrando a conversa |
| `npm run teste:painel` | o painel pelo HTTP |
| `npm run avaliar` | avaliação da leitura com a IA real (**gasta créditos** da Anthropic) |
| `npm run teste:externo -- nfeio` | emite 1 nota no ambiente de testes da NFE.io |
| `npm run importar -- <pasta> --previa` | confere planilhas de cadastro (sem `--previa`, grava) |

### 7. *(Opcional)* Ligar o e-mail de verdade no seu computador

1. No n8n (http://localhost:5678), crie a credencial **Gmail OAuth2**, como no [passo 6 do guia de instalação](docs/INSTALACAO.md#passo-6-conectar-o-gmail), e anote o ID dela.
2. Gere e importe os workflows:
   ```bash
   node n8n/workflows/gerar_workflows.js --gmail <ID> --alerta <seu e-mail>
   for f in nfs_erros nfs_email; do
     docker compose -f infra/docker-compose.yml cp n8n/workflows/$f.json n8n:/tmp/$f.json
     docker compose -f infra/docker-compose.yml exec n8n n8n import:workflow --input=/tmp/$f.json
   done
   ```
3. No n8n, ligue o workflow **NFS - E-mail** e mande um pedido de um remetente cadastrado.

### Parar

```bash
docker compose -f infra/docker-compose.yml stop
```

---

## Onde fica cada coisa

| Pasta | O quê |
|---|---|
| `motor/` | o programa principal: regras, painel, integrações |
| `n8n/` | decisão (`decidir.js`), leitura pela IA (`extrair.js`) e os workflows do n8n |
| `prompts/`, `schemas/` | instruções e formato da leitura pela IA |
| `db/` | banco de dados: migrações e dados de teste |
| `cenarios/` | as conversas de exemplo que definem o comportamento (servem de teste) |
| `avaliacao/` | avaliação da IA com casos difíceis e reais |
| `infra/` | Docker do computador de desenvolvimento |
| `infra/producao/` | instalação do escritório: instalador, backup, HTTPS |
| `docs/` | guia de instalação, roteiro de operação, modelo de planilhas |

**Documentos:** [INSTALACAO](docs/INSTALACAO.md) · [RUNBOOK](docs/RUNBOOK.md) · [Modelo de planilhas](docs/modelo-cadastro/README.md) · [Avaliação da IA](avaliacao/README.md).

---

## Perguntas frequentes

**A aplicação pode emitir uma nota errada?**
Ela só emite quando todos os dados vieram do cliente, conferem com o cadastro e estão dentro da faixa de valor da empresa. Com a confirmação "SIM" ligada, o cliente ainda confere um resumo antes. Mesmo assim, uma nota pode sair errada: o cancelamento é feito pelo escritório no painel da NFE.io ([RUNBOOK](docs/RUNBOOK.md#nota-errada)).

**Como paro as emissões rapidamente?**
Painel → **Configurações** → desmarque **Emissão automática** → Salvar. Os pedidos continuam sendo atendidos, mas vão para o colaborador em vez de virar nota.

**Quanto custa a IA?**
Cerca de US$ 0,01 a 0,02 por mensagem de cliente, com o modelo atual (medido com `npm run avaliar`).

**O servidor caiu. E agora?**
Os colaboradores atendem os pedidos à mão, como antes, enquanto alguém segue o [RUNBOOK → Sistema fora do ar](docs/RUNBOOK.md#sistema-fora-do-ar).
