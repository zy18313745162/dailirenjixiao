FROM node:24-alpine
WORKDIR /app
COPY package.json server.js domain.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/banduo.sqlite
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
