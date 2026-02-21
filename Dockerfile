# Cloud Run recomendado: Node 18+
FROM node:18-slim

WORKDIR /app

# Copia dependências primeiro para cache de build
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev || npm install --omit=dev

# Copia o restante
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
