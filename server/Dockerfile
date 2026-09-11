FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY server ./server
COPY lib ./lib
COPY scripts ./scripts
RUN mkdir -p /data/materials /backups && chown -R node:node /app /data /backups
USER node
CMD ["node", "--import", "tsx", "server/main.ts"]
