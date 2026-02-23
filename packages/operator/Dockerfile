FROM node:20-slim AS builder
WORKDIR /build

# Copy workspace root files
COPY package.json package-lock.json turbo.json tsconfig.base.json ./

# Copy packages needed for build
COPY packages/shared/ ./packages/shared/
COPY packages/operator/ ./packages/operator/

# Install all dependencies (including devDependencies for tsc/turbo)
RUN npm ci

# Build operator and its dependency (shared)
RUN npx turbo build --filter=@plattr/operator

# Production image
FROM node:20-slim AS production
WORKDIR /app

# Copy node_modules from both root (hoisted) and operator (non-hoisted)
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/operator/node_modules ./node_modules

# Copy built output
COPY --from=builder /build/packages/operator/dist ./dist
COPY --from=builder /build/packages/shared/dist ./node_modules/@plattr/shared/dist
COPY --from=builder /build/packages/shared/package.json ./node_modules/@plattr/shared/

# Non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

EXPOSE 9090

CMD ["node", "dist/index.js"]
