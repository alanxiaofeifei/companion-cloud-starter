# Smoke scaffold only; pin this official base to a reviewed digest before deployment.
FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json LICENSE NOTICE ./
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]
