# Dockerfile for linksee-memory MCP server.
# Used by Glama.ai to run the server for introspection checks.
#
# LOCAL USERS DO NOT NEED THIS — just run `npx linksee-memory` on your host.
# This file exists purely to let MCP registries (Glama, etc.) start the server
# in an isolated container and check it speaks MCP correctly.
#
# Design notes:
# - Debian slim (glibc) is chosen over Alpine (musl) because better-sqlite3's
#   native binding is more reliable under glibc and works with node's prebuilt
#   binaries from the npm registry (no native compile needed at install time).
# - Multi-stage build keeps the runtime image small.
# - Runs as non-root for security-scanner compatibility.

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

# Install dependencies first (keeps layer cached across source edits).
# We only need toolchain when the prebuilt binary is missing for our platform.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

# Build the TypeScript sources (also copies schema.sql + SKILL.md into dist/).
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ── Runtime image ───────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy only the runtime essentials.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Keep the MCP brain inside a known path so the introspection run is self-contained.
# The /data dir is created with ownership to the non-root "node" user that ships
# with the official Node.js images.
ENV LINKSEE_MEMORY_DIR=/data/linksee-memory
RUN mkdir -p /data/linksee-memory \
 && chown -R node:node /data /app

USER node

# Smoke-check: fail the container early if node can't even load the entrypoint.
# (Glama's introspection will still send MCP messages; this is just an extra guard.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('./dist/mcp/server.js')" || exit 1

# stdio server. Glama's check sends `initialize` + `tools/list` via stdin.
CMD ["node", "dist/mcp/server.js"]
