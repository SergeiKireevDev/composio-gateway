FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /app/data && chown node:node /app/data
COPY server.mjs store.mjs composio.mjs ./
COPY public ./public
USER node
ENV HOST=0.0.0.0 PORT=8788 DATA_DIR=/app/data
EXPOSE 8788
CMD ["node", "server.mjs"]
