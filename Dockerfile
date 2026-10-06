FROM node:24-alpine
WORKDIR /app
COPY package.json server.js domain.js ./
COPY public ./public
RUN apk add --no-cache su-exec && mkdir -p /app/data && chown -R node:node /app
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/banduo.sqlite
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p /app/data && chown -R node:node /app/data && exec su-exec node:node node --disable-warning=ExperimentalWarning server.js"]
