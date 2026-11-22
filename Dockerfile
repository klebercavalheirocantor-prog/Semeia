# Semeia na nuvem (Railway): Node 24 + Chromium para o WhatsApp Web.
FROM node:24-bookworm-slim

# O pacote chromium do Debian entra só pelas bibliotecas de sistema; o WhatsApp Web roda no Chrome for Testing do
# Puppeteer (o mesmo navegador do PC, onde o login do WhatsApp volta sozinho depois de reiniciar).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git chromium fonts-liberation fonts-noto-color-emoji ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    WA_ENGINE=baileys \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TRUST_PROXY=1 \
    COOKIE_SECURE=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Motor do WhatsApp sem navegador (WA_ENGINE=baileys). Fica fora do package.json para não mexer no PC;
# para voltar ao motor antigo, troque WA_ENGINE para wwebjs nas variáveis do Railway.
# Versão 7: a 6.7 não decifrava mensagens de contato novo (id interno "@lid", ex.: quem clica no anúncio) e
# elas sumiam ("failed to decrypt message"); a 7 pede o reenvio ao remetente. Versão exata para não mudar sozinha.
RUN npm install --omit=dev --no-save --no-audit --no-fund @whiskeysockets/baileys@7.0.0-rc14
COPY . .

# /data é o volume do Railway: banco, arquivos e a sessão do WhatsApp ficam lá e sobrevivem às atualizações.
EXPOSE 3000
CMD ["node", "server/index.js"]
