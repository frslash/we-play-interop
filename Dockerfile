# One small container. Point DATABASE_URL at Postgres, or leave it empty and mount
# an encrypted volume at /data for the embedded Postgres (PGlite).
FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
COPY agent ./agent
COPY rules.json ./rules.json
# the test host's Dockerfiles name the commits it builds from; the projects shelf reads those two lines so agents read what runs
COPY community ./community
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "src/server/index.js"]
