# tv3ws, the TV 3.0 WebServices (TypeScript). Build context: this repository.

FROM node:23-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:23-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 44652 44653
CMD ["node", "dist/server.js"]
