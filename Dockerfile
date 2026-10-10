# Kantor Virtual 3D — image kecil berbasis Node 22 (alpine).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8095 HOST=0.0.0.0 TASKS_FILE=/app/data/tasks.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
EXPOSE 8095
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8095/ >/dev/null || wget -qO- --no-check-certificate https://127.0.0.1:8095/ >/dev/null || exit 1
CMD ["node", "server.js"]
