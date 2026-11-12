# Make Good API and its worker in one image (the Next.js web app is deployed separately).
# Not yet built or run anywhere: the development machine has no Docker.
#
#   docker build -t make-good .
#   docker run -p 4000:4000 -v makegood-data:/data \
#     -e MAKEGOOD_ENCRYPTION_KEY=<32 random bytes, base64> make-good
#
# Without DATABASE_URL it keeps its own PostgreSQL files under /data.
FROM node:24-slim
WORKDIR /app
# npm workspaces: the root lock file and every workspace's package.json.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev -w @makegood/api
WORKDIR /app/apps/api
COPY apps/api/src ./src
COPY apps/api/db ./db
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4000
USER node
CMD ["node", "src/server.ts"]
