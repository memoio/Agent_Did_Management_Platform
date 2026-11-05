# Solidity does not publish native Linux ARM64 solc binaries. Build the
# architecture-independent artifacts under the pinned AMD64 toolchain, then
# copy them into the native runtime image.
ARG ALTO_CONTRACT_BUILDPLATFORM=linux/amd64
FROM --platform=${ALTO_CONTRACT_BUILDPLATFORM} node:20.12.2-bookworm-slim@sha256:72f2f046a5f8468db28730b990b37de63ce93fd1a72a40f531d6aa82afdf0d46 AS contract_node

FROM --platform=${ALTO_CONTRACT_BUILDPLATFORM} ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd AS contracts

WORKDIR /build
USER root
COPY --from=contract_node /usr/local/bin/ /usr/local/bin/
COPY --from=contract_node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
RUN corepack enable pnpm

COPY --from=alto_source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /build/
COPY --from=alto_source /contracts /build/contracts
RUN pnpm install --frozen-lockfile \
    && pnpm run build:contracts

FROM node:20.12.2-alpine3.19@sha256:7a91aa397f2e2dfbfcdad2e2d72599f374e0b0172be1d86eeb73f1d33f36a4b2
WORKDIR /app
RUN corepack enable

# `alto_source` is an immutable BuildKit git context configured in Compose.
COPY --from=alto_source / /app
COPY infra/alto/apply-source-patches.mjs /app/infra/alto/apply-source-patches.mjs
RUN node /app/infra/alto/apply-source-patches.mjs
# Generate the simulation helpers from the same pinned source instead of
# copying them from the published image. The latter is affected by upstream
# issue #756 and can omit DelegateAndRevert from the simulation ABI.
COPY --from=contracts /build/src/contracts /app/src/contracts
RUN pnpm fetch \
    && pnpm install -r --offline --frozen-lockfile \
    && pnpm build \
    && mkdir -p /app/src/lib/cli \
    && ln -sf /app/src/esm/cli/alto.js /app/src/lib/cli/alto.js

ENTRYPOINT ["pnpm", "start"]
