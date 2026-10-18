FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY backend/prisma backend/prisma

RUN npm ci

COPY backend backend
COPY frontend frontend
COPY README.md ./README.md

RUN npx prisma generate --schema backend/prisma/schema.prisma \
    && npm run build

ENV NODE_ENV=production
EXPOSE 4000

# The web service syncs the Prisma schema before accepting traffic.
CMD ["npm", "--workspace", "backend", "run", "start:api"]
