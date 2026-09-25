# Produkcijska slika:  docker build -t erp-wms . && docker run -p 3000:3000 --env-file .env -v erp-storage:/app/storage erp-wms
# (storage/ — kopije i MDM datoteke — mora biti na trajnom volumenu; produkcija: deploy/docker-compose.yml)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# migracije se primjenjuju pri svakom pokretanju (idempotentno)
CMD ["sh", "-c", "npx prisma migrate deploy && npx next start -p 3000"]
