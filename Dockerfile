# CallMCP OSS server — container image
#
# Builds the full pnpm workspace, then runs @callmcp/server's CLI entrypoint.
# Used both for self-hosting and for Smithery's container runtime (see smithery.yaml).

FROM node:20-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace + package manifests first so `pnpm install` is cached
# independently of source changes. Each package.json is copied individually
# (not via a `packages/*/package.json packages/` glob) because Docker COPY
# with a multi-match wildcard source flattens every match into the
# destination directory by basename — every package here is named
# "package.json", so a glob-copy silently collapses all five into one file
# and pnpm install fails to find the other four workspaces.
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages/driver-interface/package.json packages/driver-interface/package.json
COPY packages/driver-byok/package.json packages/driver-byok/package.json
COPY packages/driver-dograh/package.json packages/driver-dograh/package.json
COPY packages/driver-kaicalls/package.json packages/driver-kaicalls/package.json
COPY packages/server/package.json packages/server/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

FROM node:20-slim AS runtime

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY --from=builder /app .

# Streamable HTTP transport listens on this port when the entrypoint is
# invoked with --http (matches DEFAULT_PORT in packages/server/src/index.ts);
# the stdio transport (MCP default, used by Claude Desktop/Code, and what
# Smithery's stdio startCommand invokes) ignores it entirely.
EXPOSE 8787

# The server's actual CLI entrypoint is dist/index.js (see packages/server's
# `bin`/`main` fields) — there is no dist/cli.js anywhere in this package.
ENTRYPOINT ["node", "packages/server/dist/index.js"]
