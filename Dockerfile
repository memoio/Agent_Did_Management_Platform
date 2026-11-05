FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/console/package.json ./apps/console/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY apps ./apps
RUN npm run build

FROM node:22.22.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/console/package.json ./apps/console/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.22.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/console/public ./apps/console/public
USER node
EXPOSE 4273
CMD ["node", "dist/apps/api/src/main.js"]
