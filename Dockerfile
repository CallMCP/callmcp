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
# independently of source changes.
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages/*/package.json packages/
# NOTE: this glob-copy assumes every packages/<name>/package.json already
# exists. It will fail until the driver packages (build-04) land their own
# package.json files — expected and harmless on this scaffold commit; the
# image only builds successfully once packages/server + packages/driver-*
# are populated.

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

# Streamable HTTP transport listens here when CALLMCP_TRANSPORT=http is set;
# the stdio transport (MCP default, used by Claude Desktop/Code) ignores it.
EXPOSE 8080

ENTRYPOINT ["node", "packages/server/dist/cli.js"]
