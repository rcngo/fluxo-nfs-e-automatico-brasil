# Instalação no servidor do escritório

Guia para instalar a aplicação do zero num servidor novo. Todos os comandos são copiados e colados no terminal do servidor. Para uma visão geral, comece pelo [README](../README.md); para o dia a dia e para quando algo der errado, veja o [RUNBOOK](RUNBOOK.md).

**Tempo estimado:** 1 a 2 horas, sem contar a aprovação do modelo de mensagem do WhatsApp na Meta (pode levar um dia).

**Ao terminar:** o painel abre em `https://<domínio do escritório>/painel`, os e-mails da caixa de pedidos são atendidos e o backup roda todo dia. Até a decisão formal do escritório, as notas saem **só no ambiente de testes da NFE.io**.

---

## O que precisa estar em mãos

| Item | Para quê | Quem providencia |
|---|---|---|
| Servidor Linux (Ubuntu 24.04 LTS), com 2 vCPU, 4 GB de RAM, 40 GB de disco e IP fixo | rodar a aplicação | escritório |
| Acesso SSH ao servidor, com um usuário que pode usar `sudo` | instalar | escritório |
| Um domínio ou subdomínio, por exemplo `nfs.seuescritorio.com.br` | endereço do painel e do WhatsApp (HTTPS) | escritório |
| Chave da API da Anthropic (`sk-ant-...`) | leitura dos pedidos pela IA | quem administra a conta da Anthropic |
| Chave da API da NFE.io e as empresas cadastradas lá | emissão das notas | escritório + suporte da NFE.io |
| Conta Google da caixa de pedidos (Gmail ou Google Workspace) | receber e responder os pedidos por e-mail | escritório |
| App na Meta com o número do WhatsApp Business *(opcional; dá para ligar depois)* | atendimento por WhatsApp | escritório |
| Planilhas de cadastro *(opcional; o painel também cadastra)* | empresas, serviços, quem pode pedir nota | escritório (modelo em [`docs/modelo-cadastro/`](modelo-cadastro/README.md)) |

---

## Passo 1. Preparar o servidor

Entre no servidor por SSH e rode:

```bash
# Atualiza o sistema e instala o git
sudo apt update && sudo apt upgrade -y && sudo apt install -y git openssl

# Instala o Docker (script oficial) e libera o seu usuário para usá-lo sem sudo
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

**Saia do SSH e entre de novo**, para valer a permissão do Docker. Depois confira:

```bash
docker compose version     # deve mostrar "Docker Compose version v2..."
```

**Firewall:** deixe abertas só as portas **22** (SSH), **80** e **443** (HTTPS). No Ubuntu:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

> Se o servidor fica numa nuvem (AWS, Azure, Hostinger...), libere as mesmas portas no painel do provedor.

## Passo 2. Apontar o domínio para o servidor

No painel de DNS do domínio, crie um registro do tipo **A**:

| Tipo | Nome | Valor |
|---|---|---|
| A | `nfs` (ou o subdomínio escolhido) | IP do servidor |

Confira de qualquer computador (pode levar alguns minutos para valer):

```bash
ping nfs.seuescritorio.com.br     # deve responder com o IP do servidor
```

Sem esse passo, o certificado HTTPS não é emitido e o painel não abre.

## Passo 3. Copiar a aplicação para o servidor

Com o repositório num serviço como o GitHub:

```bash
cd ~ && git clone <endereço do repositório> nfs && cd nfs
```

Sem repositório remoto, copie a pasta do projeto do seu computador (sem `node_modules`):

```bash
# no SEU computador, na pasta do projeto:
rsync -av --exclude node_modules --exclude .git --exclude 'infra/*.env' ./ usuario@servidor:~/nfs/
```

## Passo 4. Rodar o instalador

```bash
cd ~/nfs/infra/producao
./instalar.sh
```

O instalador:
1. confere se o Docker está pronto;
2. pergunta o **domínio**, um **e-mail** (para os avisos do certificado HTTPS), a **chave da Anthropic**, a **chave da NFE.io** e, se já tiver, o **App Secret da Meta** (Enter pula);
3. gera sozinho as senhas internas (banco, chave de criptografia do n8n, token do webhook do WhatsApp);
4. cria os arquivos `.env` e `secrets.env` nesta pasta, que só o seu usuário consegue ler;
5. constrói e sobe os serviços. As tabelas do banco são criadas quando o motor sobe;
6. pergunta o **nome e o e-mail do primeiro colaborador** e mostra a **senha do painel** dele. **Anote: ela aparece só uma vez.**

No fim, abra `https://<domínio>/painel` no navegador e entre com esse e-mail e essa senha.

> **Muito importante:** copie o conteúdo do `.env` e do `secrets.env` para o cofre de senhas do escritório (ex.: Bitwarden, 1Password). Sem a `N8N_ENCRYPTION_KEY`, um backup restaurado num servidor novo perde as conexões do Gmail e do WhatsApp.
>
> ```bash
> cat ~/nfs/infra/producao/.env ~/nfs/infra/producao/secrets.env
> ```

Rodar o `./instalar.sh` de novo não apaga nada: ele só reconstrói e sobe (é assim que se atualiza, ver [Atualizar a aplicação](#atualizar-a-aplicação)).

## Passo 5. Abrir o editor do n8n (túnel SSH)

O n8n é o "carteiro": busca os e-mails, recebe o WhatsApp e envia as respostas. Por segurança, o editor dele **não fica na internet**. Ele é aberto pelo seu computador, por um túnel SSH.

No **seu computador** (não no servidor), deixe este comando rodando:

```bash
ssh -N -L 5678:127.0.0.1:5678 usuario@servidor
```

Enquanto ele roda, abra **http://localhost:5678** no navegador. Na primeira vez, o n8n pede para criar a conta de administrador (e-mail e senha do escritório; guarde no cofre).

## Passo 6. Conectar o Gmail

### 6.1 No Google Cloud (uma vez)

1. Entre em https://console.cloud.google.com com a conta da caixa de pedidos e crie um projeto (ex.: "NFS Escritório").
2. **APIs e serviços → Biblioteca**: procure **Gmail API** e clique em **Ativar**.
3. **APIs e serviços → Tela de consentimento OAuth** (ou "Google Auth Platform"): tipo **Interno** se a conta for Google Workspace, ou **Externo** se for um Gmail comum. Preencha o nome do app e o e-mail de suporte.
   - Se for **Externo**, em **Público-alvo**, clique em **Publicar app** ("Em produção"). **No modo "Teste", a conexão expira a cada 7 dias** e o atendimento por e-mail para sem avisar.
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**
   - URIs de redirecionamento autorizados: `http://localhost:5678/rest/oauth2-credential/callback`
   - Guarde o **ID do cliente** e a **chave secreta do cliente**.

### 6.2 No n8n

1. Com o túnel aberto, vá em http://localhost:5678 → **Overview → Credentials → Create credential → Gmail OAuth2 API**.
2. Cole o ID e a chave secreta do cliente e clique em **Sign in with Google**. Entre com a conta da caixa de pedidos e aceite. Se for Gmail comum, o Google avisa que o app não foi verificado: clique em **Avançado → Acessar**.
3. Salve. O endereço da página fica assim: `http://localhost:5678/home/credentials/`**`AbC123xyz`**. A parte final é o **ID da credencial**: anote.

> O retorno do Google vai para `localhost` de propósito: ele só funciona com o editor aberto pelo túnel. Testado na instalação: pelo domínio público, o n8n recusa a conexão.

## Passo 7. Importar e ligar os workflows

No **servidor**:

```bash
cd ~/nfs/infra/producao
./workflows.sh --gmail <ID da credencial do Gmail> --alerta <e-mail que recebe alertas de erro>
```

No n8n (http://localhost:5678), abra o workflow **NFS - E-mail** e ligue a chave **Active/Publish** (canto superior direito). O **NFS - Erros** não precisa ser ligado: ele é chamado sozinho quando outro workflow falha.

**Teste:** de um e-mail cadastrado como remetente (passo 8), mande um pedido para a caixa de pedidos. Em até 1 minuto, a resposta chega e o pedido aparece no painel.

## Passo 8. Cadastrar empresas, serviços e quem pode pedir nota

**Pelo painel** (`https://<domínio>/painel`):
- **Empresas → Nova empresa:** CNPJ, razão social, ID da empresa na NFE.io, município (código IBGE), faixa de valor e se exige confirmação "SIM" (deixe **ligado** nas empresas piloto).
- Dentro da empresa: os **serviços**, com os códigos (o contador indica a retenção) e **quem pode pedir nota**, por e-mail ou WhatsApp.
- **Colaboradores:** os outros colaboradores, com o botão **Gerar senha** para cada um.

**Ou por planilha**, para muitos cadastros de uma vez. Preencha os modelos de [`docs/modelo-cadastro/`](modelo-cadastro/README.md), salve como CSV e coloque os arquivos em `~/nfs/infra/producao/cadastro/` no servidor. Depois rode:

```bash
cd ~/nfs/infra/producao
docker compose exec motor node scripts/importar.js /cadastro --previa   # confere e mostra os erros, sem gravar
docker compose exec motor node scripts/importar.js /cadastro            # grava
```

## Passo 9. WhatsApp (quando a conta da Meta estiver pronta)

1. Em https://developers.facebook.com, no app da empresa (produto **WhatsApp**), anote:
   - o **Phone number ID** do número;
   - o **App Secret** (Configurações do app → Básico);
   - um **token permanente** de um usuário do sistema (Business Manager → Usuários do sistema → Gerar token, com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`).
2. No servidor, coloque o App Secret no `secrets.env` e reinicie o motor:
   ```bash
   cd ~/nfs/infra/producao
   nano secrets.env                 # preencha WHATSAPP_APP_SECRET=...
   docker compose up -d motor
   grep WHATSAPP_VERIFY_TOKEN secrets.env   # anote o token de verificação
   ```
3. No n8n, crie a credencial **Header Auth** com o nome `WhatsApp Cloud API`, *Name* = `Authorization` e *Value* = `Bearer <token permanente>`. Anote o ID dela (no endereço da página, como no Gmail).
4. Importe de novo os workflows, agora com o WhatsApp:
   ```bash
   ./workflows.sh --gmail <ID Gmail> --alerta <e-mail> --whatsapp-cred <ID Header Auth> --whatsapp-numero <Phone number ID>
   ```
   Os workflows voltam desligados: ligue de novo o **NFS - E-mail** e ligue o **NFS - WhatsApp**.
5. Na Meta, **WhatsApp → Configuração → Webhook**:
   - URL de retorno: `https://<domínio>/webhook/whatsapp`
   - Token de verificação: o `WHATSAPP_VERIFY_TOKEN` anotado
   - Clique em **Verificar e salvar** e assine o campo **messages**.
6. Em **WhatsApp → Modelos de mensagem**, crie o modelo **`nfse_atualizacao`**: categoria *Utility*, idioma *Português (BR)*, corpo `Atualização do seu pedido de nota fiscal: {{1}}`. Ele é usado para avisar o cliente depois de 24 h sem conversa.
7. No painel, cadastre os números de WhatsApp autorizados em **Empresas → quem pode pedir nota**.

## Passo 10. Backup

O backup já está rodando: **todo dia às 02:30**, ele guarda os dois bancos (pedidos e cadastros; workflows e credenciais do n8n) e a pasta de notas em `~/nfs/infra/producao/backups/AAAA-MM-DD_HHMM/`. Cada backup é **restaurado numa base temporária logo depois**, para garantir que funciona. O painel mostra em **Configurações** o último backup e avisa em **Pedidos** se o backup falhar ou atrasar mais de 48 h. Os backups com mais de 30 dias são apagados (mude `BACKUP_HORA` e `BACKUP_DIAS` no `.env`).

Faça um backup agora, para conferir:

```bash
cd ~/nfs/infra/producao
docker compose exec backup bash /scripts/backup.sh agora
cat backups/*/OK.txt
```

**Guarde uma cópia fora do servidor.** Se o servidor for perdido, os backups dentro dele também se perdem. Exemplo, toda noite, de outro computador ou de um serviço de armazenamento:

```bash
rsync -av usuario@servidor:~/nfs/infra/producao/backups/ /caminho/da/copia/
```

Restaurar está no [RUNBOOK](RUNBOOK.md#restaurar-um-backup).

## Passo 11. Conferência final

| Conferir | Como |
|---|---|
| Painel abre com cadeado (HTTPS) | `https://<domínio>/painel` |
| As rotas internas não estão na internet | `https://<domínio>/processar` deve dar **404** |
| E-mail de pedido recebe resposta | passo 7 |
| WhatsApp responde (se configurado) | mandar "oi" de um número cadastrado |
| Backup verificado | `cat backups/*/OK.txt` |
| Emissão só de teste | painel → Configurações → Instalação: "somente de teste" |
| `.env` e `secrets.env` no cofre de senhas | passo 4 |

Para ligar a emissão real, siga o [RUNBOOK → Ligar a emissão real](RUNBOOK.md#ligar-a-emissão-real-produção). Ela só pode ser ligada com a decisão formal do escritório.

---

## Atualizar a aplicação

```bash
cd ~/nfs && git pull                 # ou copie a pasta nova como no passo 3
cd infra/producao && ./instalar.sh   # reconstrói e sobe; as migrações do banco rodam sozinhas
```

Se a atualização mudou os workflows do n8n, rode também o `./workflows.sh` (passo 7) e ligue os workflows de novo.

## Comandos úteis (na pasta `~/nfs/infra/producao`)

| O quê | Comando |
|---|---|
| Ver se está tudo rodando | `docker compose ps` |
| Ver os registros do motor (últimas 100 linhas) | `docker compose logs --tail 100 motor` |
| Reiniciar tudo | `docker compose restart` |
| Parar tudo | `docker compose stop` |
| Subir tudo | `docker compose up -d` |
| Nova senha do painel para um colaborador | `docker compose exec motor node scripts/senha-painel.js <e-mail>` |
| Backup agora | `docker compose exec backup bash /scripts/backup.sh agora` |

## Como a instalação é montada

```
Internet ──443──► Caddy (HTTPS) ──► /painel, /resolvido ──► motor (regras, painel)
                                └─► /webhook/whatsapp  ──► n8n ──► motor
                                    (qualquer outro caminho: 404)

n8n ──► Gmail (busca e responde), WhatsApp (envia)      editor: só por túnel SSH
motor ──► Anthropic (lê o pedido), NFE.io (emite), BrasilAPI (confere o CNPJ)
Postgres: bancos "nfs" (aplicação) e "n8n"              sem porta aberta
backup ──► ./backups (todo dia, verificado)
```

| Arquivo em `infra/producao/` | O quê |
|---|---|
| `docker-compose.yml` | os serviços: postgres, n8n, motor, caddy, backup |
| `Caddyfile` | o que fica aberto na internet |
| `Dockerfile` | imagem do motor |
| `instalar.sh` | instalação e atualização |
| `workflows.sh` | gera e importa os workflows do n8n |
| `backup.sh` | backup diário com verificação (roda no serviço `backup`) |
| `restaurar.sh` | restaura um backup |
| `.env`, `secrets.env` | configuração e chaves (**fora do git**; criados pelo instalador) |
| `backups/`, `cadastro/` | backups e planilhas (**fora do git**) |
