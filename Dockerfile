# Scrima API Server — Multi-stage Docker build
# Builds @scrima/shared + @scrima/server in a pnpm workspace, then runs a minimal production image.

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy only the packages we need (shared + server)
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/

# Build shared first (server depends on it), then server
RUN pnpm --filter @scrima/shared build && \
    pnpm --filter @scrima/server build

# ── Stage 2: Production ────────────────────────────────────
FROM node:22-slim AS runner

# Note: sharp and onnxruntime-node require glibc (slim provides this, Alpine does not).

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/server/dist packages/server/dist

# Copy drizzle migrations (needed for db:migrate on startup)
COPY packages/server/drizzle.config.ts packages/server/
COPY packages/server/src/db/ packages/server/src/db/

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

USER node

# Run the server
CMD ["node", "packages/server/dist/index.js"]
