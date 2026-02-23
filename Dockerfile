# Stage 1: Install dependencies and build the project
FROM node:24-bookworm-slim AS builder
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

RUN npm config delete proxy \
    && npm config delete https-proxy \
    && npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Build crelay binary
FROM debian:bookworm-slim AS crelay-builder
ARG CRELAY_REF=master
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gcc \
        make \
        libusb-1.0-0-dev \
        libftdi1-dev \
        libhidapi-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN curl -fsSL "https://github.com/ondrej1024/crelay/archive/${CRELAY_REF}.tar.gz" -o crelay.tar.gz \
    && tar -xzf crelay.tar.gz \
    && cd "crelay-${CRELAY_REF}/src" \
    && make \
    && install -m 0755 crelay /usr/local/bin/crelay

# Stage 3: Runtime image with mount tools
FROM node:24-bookworm-slim AS runtime
ARG BUILD_VERSION
ARG BUILD_TIMESTAMP
ARG YTDLP_VERSION=2026.02.04
ENV APP_VERSION=${BUILD_VERSION}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV XDG_CACHE_HOME=/app/data/.cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        cifs-utils \
        keyutils \
        nfs-common \
        curl \
        libusb-1.0-0 \
        libftdi1-2 \
        libhidapi-libusb0 \
        python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -L -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
    && chmod +x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=crelay-builder /usr/local/bin/crelay /usr/local/bin/crelay
RUN chmod +x /usr/local/bin/crelay \
    && /usr/local/bin/crelay --help >/dev/null || true
RUN mkdir -p /app/data/.cache && chown -R node:node /app/data
# Start the application
CMD ["node", "dist/server.js"]
