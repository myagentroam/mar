# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.15.0-bookworm@sha256:f22d6a1f082c02f292e86929b5b0442ac2e5eaf438a5dea9b1566601c3e05940 AS dependencies

WORKDIR /workspace

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN corepack enable \
  && corepack install --global pnpm@11.21.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/code-navigation/package.json packages/code-navigation/package.json
COPY packages/server-core/package.json packages/server-core/package.json
COPY packages/web-core/package.json packages/web-core/package.json
COPY mar-server/package.json mar-server/package.json
COPY mar-web-console/package.json mar-web-console/package.json
COPY ee/server/package.json ee/server/package.json
COPY ee/web/package.json ee/web/package.json

# Copied lockfile is the trusted source; skip registry age/trust re-verification.
RUN --mount=type=cache,id=myagentroam-pnpm-store-v11,target=/root/.local/share/pnpm/store,sharing=locked \
  --mount=type=cache,id=myagentroam-node-gyp,target=/root/.cache/node-gyp,sharing=locked \
  --mount=type=cache,id=myagentroam-pnpm-cache,target=/root/.cache/pnpm,sharing=locked \
  pnpm --trust-lockfile --filter @myagentroam/server... --filter @myagentroam/web-console... install --frozen-lockfile --prefer-offline

FROM dependencies AS web-build

COPY packages/protocol packages/protocol
COPY scripts/clean-build-output.mjs scripts/clean-build-output.mjs

COPY packages/code-navigation packages/code-navigation
COPY packages/web-core packages/web-core
COPY ee/web ee/web
COPY mar-web-console mar-web-console
COPY docs/help docs/help
COPY docs/assets docs/assets
COPY scripts/validate-help-docs.mjs scripts/validate-help-docs.mjs

RUN pnpm --filter @myagentroam/web-console... build

FROM dependencies AS server-build

COPY packages/protocol packages/protocol
COPY packages/server-core packages/server-core
COPY mar-server mar-server
COPY ee/server ee/server
COPY --from=web-build /workspace/mar-web-console/dist mar-web-console/dist
COPY scripts/clean-build-output.mjs scripts/clean-build-output.mjs

RUN pnpm --filter-prod @myagentroam/server... build
RUN --mount=type=cache,id=myagentroam-pnpm-store-v11,target=/root/.local/share/pnpm/store,sharing=locked \
  --mount=type=cache,id=myagentroam-pnpm-cache,target=/root/.cache/pnpm,sharing=locked \
  pnpm --trust-lockfile --filter @myagentroam/server deploy --prod /runtime/server
RUN find /runtime/server -type f -name '*.map' -delete \
  && find /runtime/server -type f -name '*.d.ts' -delete

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS server

WORKDIR /opt/myagentroam

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=server-build --chown=node:node /runtime/server ./
COPY LICENSE NOTICE LICENSING.md ./
COPY ee/LICENSE ./LICENSE.ee
COPY --chmod=755 docker/server-entrypoint.sh /usr/local/bin/myagentroam-server-entrypoint

ENV NODE_ENV=production
ENV MAR_SERVER_HOST=0.0.0.0
ENV MAR_SERVER_PORT=5190
ENV MAR_DATABASE_URL=mysql://myagentroam@mysql:13006/myagentroam
ENV MAR_DATA_DIR=/var/lib/myagentroam

EXPOSE 5190
USER root

ENTRYPOINT ["/usr/local/bin/myagentroam-server-entrypoint"]
