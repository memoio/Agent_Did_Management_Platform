FROM node:22.22.0-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/chain-worker/package.json ./apps/chain-worker/package.json
COPY apps/console/package.json ./apps/console/package.json
COPY packages/aa-client/package.json ./packages/aa-client/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/skill/package.json ./packages/skill/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build \
    && npm run contracts:artifacts \
    && test -f packages/contracts/out/AgentDIDRegistryV1.sol/AgentDIDRegistryV1.json \
    && test -f packages/contracts/out/AgentManagementRegistryV1.sol/AgentManagementRegistryV1.json

FROM base AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/chain-worker/package.json ./apps/chain-worker/package.json
COPY apps/console/package.json ./apps/console/package.json
COPY packages/aa-client/package.json ./packages/aa-client/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/skill/package.json ./packages/skill/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/console/public ./apps/console/public
COPY --from=build /app/deploy ./deploy
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 4273
CMD ["node", "dist/apps/api/src/main.js"]
