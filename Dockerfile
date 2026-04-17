# Dockerfile for linksee-memory MCP server.
# Used by Glama.ai to run the server for introspection checks.
#
# LOCAL USERS DO NOT NEED THIS — just run `npx linksee-memory` on your host.
# This file exists purely to let MCP registries (Glama, etc.) start the server
# in an isolated container and check it speaks MCP correctly.

FROM node:20-alpine AS build

# better-sqlite3 compiles a native binding; Alpine needs toolchain + sqlite headers.
RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

# Install dependencies first (keeps the image layer cached across source edits).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Build the TypeScript sources.
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf src tsconfig.json

# ── Runtime image ───────────────────────────────────────────────────────────
FROM node:20-alpine

# sqlite shared lib is needed at runtime for better-sqlite3.
RUN apk add --no-cache sqlite-libs

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Keep the MCP brain inside a known path so the introspection run is self-contained.
ENV LINKSEE_MEMORY_DIR=/data/linksee-memory
RUN mkdir -p /data/linksee-memory

# stdio server. Glama's check only needs `initialize` + `tools/list` to succeed.
CMD ["node", "dist/mcp/server.js"]
