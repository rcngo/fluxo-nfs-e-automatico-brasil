# Roteiro de operação (RUNBOOK)

O que fazer quando algo der errado, e as operações de rotina. Os comandos rodam no servidor, na pasta `~/nfs/infra/producao`. A instalação está em [INSTALACAO.md](INSTALACAO.md).

| Situação | Ir para |
|---|---|
| A aplicação parou (painel não abre, ninguém recebe resposta) | [Sistema fora do ar](#sistema-fora-do-ar) |
| Saiu uma nota errada | [Nota errada](#nota-errada) |
| Preciso parar as emissões agora | [Desligar a emissão](#desligar-a-emissão) |
| Os pedidos por e-mail não são mais respondidos | [O Gmail desconectou](#o-gmail-desconectou) |
| O painel avisa que o backup falhou | [Backup falhou](#backup-falhou) |
| Perdi o servidor, ou os dados se corromperam | [Restaurar um backup](#restaurar-um-backup) |
| Esqueci a senha do painel | [Senha do painel](#senha-do-painel) |
| O escritório decidiu ligar as notas reais | [Ligar a emissão real](#ligar-a-emissão-real-produção) |

---

## Sistema fora do ar

**Primeiro, o escritório não para:** enquanto a aplicação estiver fora, os colaboradores atendem os pedidos **como antes da aplicação**. Leem a caixa de pedidos e o WhatsApp e emitem pelo painel da NFE.io (https://app.nfe.io). Anote quais pedidos foram atendidos à mão.

**Depois, investigar:**

```bash
cd ~/nfs/infra/producao
docker compose ps                       # todos devem estar "running"; o motor e o postgres "healthy"
docker compose logs --tail 100 motor    # erros do motor
docker compose logs --tail 100 n8n      # erros do n8n
docker compose logs --tail 50 caddy     # problemas de HTTPS ou de domínio
df -h /                                 # disco cheio?
```

| Sintoma | Provável causa | O que fazer |
|---|---|---|
| Algum serviço parado ou reiniciando | erro ao subir | `docker compose up -d`; se continuar, ver o log do serviço |
| `caddy` com erro de certificado | o domínio não aponta para o servidor, ou as portas 80/443 estão fechadas | conferir o DNS e o firewall ([INSTALACAO, passos 1 e 2](INSTALACAO.md#passo-2-apontar-o-domínio-para-o-servidor)) |
| Disco cheio | backups ou registros antigos | diminuir `BACKUP_DIAS` no `.env`; `docker system prune` apaga imagens antigas, sem tocar nos dados |
| Motor com erro da Anthropic (401, crédito) | chave inválida ou sem crédito | trocar `ANTHROPIC_API_KEY` no `secrets.env` e rodar `docker compose up -d motor` |
| Servidor reiniciou | queda de energia, atualização | os serviços sobem sozinhos; conferir com `docker compose ps` |

**Quando voltar:**
- **E-mails que chegaram durante a queda:** confira se viraram pedidos no painel. O que já foi atendido à mão e reaparecer como pedido deve ser **cancelado** ou **marcado como resolvido** no painel, para não sair nota duplicada. Na dúvida, desligue a emissão (abaixo) antes de religar o n8n e confira um por um.
- **WhatsApp:** a Meta reenvia por um tempo as mensagens que não conseguiu entregar. Confira no painel do mesmo jeito.

## Nota errada

A aplicação **não cancela nem substitui notas**. Isso é sempre feito por uma pessoa do escritório:

1. Entre no painel da NFE.io (https://app.nfe.io), na empresa, e **cancele** a nota (ou faça a substituição, se o município permitir). Confira o prazo de cancelamento do município.
2. Se precisar de uma nota correta, emita pela NFE.io, ou peça ao cliente para mandar o pedido de novo com os dados certos.
3. No painel da aplicação, abra o pedido e registre o que aconteceu em **Marcar como resolvido**, com uma observação.
4. Se o erro veio de um cadastro (serviço, código, valor máximo), corrija em **Empresas**. Se a aplicação entendeu errado o pedido, avise o desenvolvedor com o número do pedido, para virar um caso de teste.

Quando o **cliente** pede para cancelar ou refazer uma nota, a aplicação não emite nada e encaminha o pedido ao colaborador, com o motivo "nota já emitida".

## Desligar a emissão

**Pelo painel (o normal):** **Configurações → Emissão automática → desmarcar "Ligada" → Salvar.** Vale para o próximo pedido. A aplicação continua conversando com os clientes, mas os pedidos prontos vão para o colaborador em vez de virar nota. Para religar, marque de novo.

**Emergência, sem acesso ao painel:** pare a entrada de mensagens. Nenhum pedido novo é lido:

```bash
cd ~/nfs/infra/producao && docker compose stop n8n
```

Para voltar: `docker compose start n8n`.

## O Gmail desconectou

Sinal: ninguém recebe resposta por e-mail, e o log do n8n mostra erro de autorização do Gmail.

1. Abra o túnel SSH e o n8n ([INSTALACAO, passo 5](INSTALACAO.md#passo-5-abrir-o-editor-do-n8n-túnel-ssh)).
2. **Credentials → a credencial do Gmail → Reconnect / Sign in with Google**, e entre com a conta da caixa de pedidos.
3. Se acontece **a cada 7 dias**, o app OAuth está em modo "Teste" no Google Cloud: publique-o ([INSTALACAO, passo 6.1](INSTALACAO.md#61-no-google-cloud-uma-vez), item 3).
4. Os e-mails que chegaram nesse tempo: confira no painel, como em [Sistema fora do ar](#sistema-fora-do-ar).

## Backup falhou

O painel mostra o motivo em **Configurações → Instalação**. Também dá para ver no servidor:

```bash
cd ~/nfs/infra/producao
docker compose logs --tail 50 backup
ls backups/                      # pastas terminadas em ".parcial" são backups que falharam
df -h /                          # disco cheio é a causa mais comum
docker compose exec backup bash /scripts/backup.sh agora    # tentar de novo
```

Depois que um backup der certo, o aviso some do painel. Pastas `.parcial` podem ser apagadas.

## Restaurar um backup

**Tudo o que aconteceu depois do backup se perde** (pedidos, cadastros, notas). Use só em desastre.

**No mesmo servidor:**

```bash
cd ~/nfs/infra/producao
ls backups/                                    # escolha o backup (o mais recente com OK.txt)
./restaurar.sh backups/2026-10-14_0230         # pede para digitar RESTAURAR
```

O script para a aplicação, substitui os dois bancos e a pasta de notas, e sobe tudo de novo.

**Num servidor novo** (o antigo foi perdido):
1. Siga a [INSTALACAO](INSTALACAO.md) até o passo 3.
2. **Antes do instalador**, copie para `~/nfs/infra/producao/` o **`.env` e o `secrets.env` guardados no cofre de senhas** (sem eles, as credenciais do n8n não abrem), e a pasta do backup para `~/nfs/infra/producao/backups/`.
3. Se o IP mudou, aponte o domínio para o servidor novo (passo 2).
4. Rode `./instalar.sh --para-restaurar` (ele usa o `.env` copiado e não pergunta nada) e depois `./restaurar.sh backups/<pasta>`.
5. Confira o painel e se os workflows estão ligados no n8n.

**Testado** em 14/10/2026: instalação do zero, backup, mudanças depois dele (colaborador novo, nota alterada, workflow apagado) e restauração, que voltou tudo ao estado do backup.

## Senha do painel

Outro colaborador gera pelo painel (**Colaboradores → Gerar senha**). Se ninguém consegue entrar:

```bash
cd ~/nfs/infra/producao
docker compose exec motor node scripts/senha-painel.js <e-mail do colaborador>
```

A senha aparece uma vez. O colaborador troca em **Minha senha**. Depois de 5 senhas erradas seguidas, o e-mail fica bloqueado por 15 minutos.

## Ligar a emissão real (produção)

A aplicação só emite nota real com **duas** configurações no servidor: a chave ligada **e** a referência da decisão formal do escritório. Sem a referência, o motor nem sobe. A NFE.io também precisa estar com a empresa no ambiente de produção.

### Antes: tudo isto precisa estar feito

- [ ] **Homologação:** as empresas piloto configuradas na NFE.io com o certificado A1, notas típicas de cada uma emitidas no ambiente de testes e o **ISS conferido pelo contador**. Confirme com o suporte da NFE.io como emitir na homologação nacional.
- [ ] **Termo de autorização** assinado por cada empresa piloto (aceita a emissão por pedido via e-mail/WhatsApp).
- [ ] **Confirmação "SIM" ligada** nas empresas piloto (painel → Empresas), e no máximo 2 ou 3 empresas.
- [ ] **Decisão formal do escritório** registrada (ata, e-mail ou documento assinado), com data e quem decidiu.
- [ ] Backup recente verificado (painel → Configurações).

### Ligar

1. Na NFE.io, passe a empresa piloto para o ambiente de **produção** (com o suporte, se for preciso).
2. No servidor:
   ```bash
   cd ~/nfs/infra/producao
   nano .env
   ```
   e altere as duas linhas:
   ```
   EMISSAO_PRODUCAO_HABILITADA=true
   EMISSAO_PRODUCAO_DECISAO=Ata de 03/11/2026, assinada por <nome>, empresas X e Y
   ```
3. Aplique: `docker compose up -d motor`
4. Confira: `docker compose logs --tail 5 motor` deve mostrar **"ATENÇÃO: emissão REAL liberada"**, e o painel, em **Configurações → Instalação**, "Notas emitidas: reais (produção)".

### Nas duas primeiras semanas

- Olhe o painel **todo dia**: as notas emitidas e os encaminhados.
- Confira cada nota real contra o pedido do cliente (valor, tomador, serviço, competência).
- Qualquer nota errada: [Nota errada](#nota-errada), e considere [desligar a emissão](#desligar-a-emissão) até entender a causa.
- Só acrescente empresas novas depois desse período, e com a mesma lista acima.

### Voltar só para teste

No `.env`, `EMISSAO_PRODUCAO_HABILITADA=false`, e depois `docker compose up -d motor`.

> Empresa com inscrição estadual cadastrada na NFE.io é bloqueada pela trava (a nota iria para outro padrão). Os pedidos dela vão ao colaborador. Confirme com o suporte da NFE.io durante a homologação.
