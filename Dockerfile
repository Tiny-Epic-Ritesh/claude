# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build the React client
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /build

# Install client dependencies
COPY client/package*.json ./client/
RUN npm ci --prefix client

# Install server production dependencies
COPY server/package*.json ./server/
RUN npm ci --prefix server --omit=dev

# Copy source and build the React app.
# --base=/ai-crm/ makes all asset URLs and React Router work correctly
# when the app is served under labs.tinyepic.in/ai-crm/
COPY client/ ./client/
RUN npm run build --prefix client -- --base=/ai-crm/

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Production runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

# Security: run as a non-root user
RUN addgroup -S bonanza && adduser -S bonanza -G bonanza

WORKDIR /app

# Copy production server deps from builder (already --omit=dev)
COPY --from=builder /build/server/node_modules ./server/node_modules

# Copy server source
COPY server/src/ ./server/src/
COPY server/package.json ./server/package.json

# Copy the built React app — Nginx will serve these as static files
COPY --from=builder /build/client/dist ./client/dist

# The SQLite database lives in /app/server/data — a named Docker volume is
# mounted here at runtime so the DB persists across container restarts.
RUN mkdir -p /app/server/data && chown -R bonanza:bonanza /app

USER bonanza

EXPOSE 4100

CMD ["node", "server/src/index.js"]
