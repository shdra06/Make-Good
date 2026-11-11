# Make Good: the API, its worker and the web page in one image.
# Not yet built or run anywhere: the development machine has no Docker.
#
#   docker build -t make-good .
#   docker run -p 4000:4000 -v makegood-data:/data \
#     -e MAKEGOOD_ENCRYPTION_KEY=<32 random bytes, base64> make-good
#
# Without DATABASE_URL it keeps its own PostgreSQL files under /data.
FROM node:24-slim
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev
COPY apps/api/src ./src
COPY apps/api/db ./db
COPY apps/web/public /app/apps/web/public
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4000
USER node
CMD ["node", "src/server.ts"]
