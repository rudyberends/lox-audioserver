ARG BUILD_FROM
FROM $BUILD_FROM

ARG BUILD_VERSION
ARG BUILD_ARCH
ARG LOX_AUDIOSERVER_REPOSITORY="https://github.com/rudyberends/lox-audioserver.git"
ARG LOX_AUDIOSERVER_REF="main"

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}"

ENV \
  CONFIG_DIR=/data \
  CONFIG_FILE=/data/config.json \
  AUDIOSERVER_LOG_FILE=/data/loxone-audio-server.log \
  CONFIG_ADMIN_DIR=/opt/lox-audioserver/public/admin \
  HUSKY=0 \
  npm_config_production=false \
  PATH="/opt/lox-audioserver/node_modules/.bin:${PATH}"

RUN \
  apk add --no-cache \
    bash \
    git \
    make \
    g++ \
    nodejs \
    npm \
    python3 \
    tzdata

WORKDIR /tmp/lox-audioserver

RUN \
  git clone --filter=blob:none --depth=1 --branch "${LOX_AUDIOSERVER_REF}" "${LOX_AUDIOSERVER_REPOSITORY}" . && \
  npm ci && \
  npm run build && \
  npm prune --omit=dev && \
  npm cache clean --force && \
  mkdir -p /opt/lox-audioserver && \
  cp -r dist public package*.json node_modules /opt/lox-audioserver/ && \
  cp README.md LICENSE /opt/lox-audioserver/ && \
  rm -rf /tmp/lox-audioserver

COPY rootfs /

WORKDIR /opt/lox-audioserver

ENV NODE_ENV=production npm_config_production=true

ENTRYPOINT ["/init"]
