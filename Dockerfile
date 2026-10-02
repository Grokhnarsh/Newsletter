FROM node:22-alpine

ENV NODE_ENV=production \
    DATABASE_PATH=/data/newsletter.db \
    UPLOADS_DIR=/data/uploads \
    MAIL_OUTBOX_DIR=/data/outbox

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY modules ./modules

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
