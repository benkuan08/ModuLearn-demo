FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN npm run build && npm test
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
