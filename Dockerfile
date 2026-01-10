# Stage 1: Install dependencies and build the project
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./

# Install minimal build tooling (prebuilds should handle most deps on glibc)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        make \
        g++ \
        python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Runtime image with mount tools
FROM node:20-bookworm-slim AS runtime
ARG BUILD_VERSION
ARG BUILD_TIMESTAMP
ENV APP_VERSION=${BUILD_VERSION}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        cifs-utils \
        keyutils \
        nfs-common \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package*.json ./
RUN mkdir -p /app/data && chown -R node:node /app/data
# Start the application
CMD ["node", "dist/server.js"]
