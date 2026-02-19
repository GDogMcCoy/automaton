# Conway Automaton - Production Dockerfile

# ── Build Stage ──────────────────────────────────────────────────
FROM node:20.19.0-alpine AS builder

WORKDIR /build

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ sqlite-dev

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/

# Install pnpm
RUN npm install -g pnpm@9.15.0

# Install dependencies (frozen lockfile for reproducibility)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# ── Production Stage ─────────────────────────────────────────────
FROM node:20.19.0-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 automaton && \
    adduser -u 1000 -G automaton -s /bin/sh -D automaton

# Install runtime dependencies only
RUN apk add --no-cache sqlite-libs curl

# Copy built artifacts from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/packages/cli/dist ./packages/cli/dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=builder /build/package.json ./
COPY --from=builder /build/packages/cli/package.json ./packages/cli/

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R automaton:automaton /app

# Switch to non-root user
USER automaton

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Expose health check port
EXPOSE 8080 9090

# Set environment
ENV NODE_ENV=production
ENV AUTOMATON_DATA_DIR=/app/data

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--run"]
