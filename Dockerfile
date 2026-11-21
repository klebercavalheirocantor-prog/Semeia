# Semeia na nuvem (Railway): Node 24 + Chromium para o WhatsApp Web.
FROM node:24-bookworm-slim

# Chromium do Debian (o WhatsApp Web roda nele) e fontes para emojis/acentos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TRUST_PROXY=1 \
    COOKIE_SECURE=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# /data é o volume do Railway: banco, arquivos e a sessão do WhatsApp ficam lá e sobrevivem às atualizações.
EXPOSE 3000
CMD ["node", "server/index.js"]
