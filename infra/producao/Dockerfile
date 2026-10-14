# Imagem do motor para a instalação do escritório (o desenvolvimento usa node:24-alpine com a pasta montada).
# Construída pelo docker-compose.yml desta pasta, a partir da raiz do repositório.
FROM node:24-alpine

RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=America/Sao_Paulo
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY motor ./motor
COPY n8n ./n8n
COPY db ./db
COPY prompts ./prompts
COPY schemas ./schemas
COPY scripts ./scripts
COPY docs/modelo-cadastro ./docs/modelo-cadastro

# Pasta das notas (XML para o Domínio): o volume "notas" herda o dono na criação.
RUN mkdir -p /app/saida/dominio && chown -R node:node /app/saida
USER node

# Migrações pendentes antes de subir (sem os dados de teste da PoC).
CMD ["sh", "-c", "node db/migrar.js && node motor/server.js"]
