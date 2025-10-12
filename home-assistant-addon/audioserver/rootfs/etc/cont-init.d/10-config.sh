#!/command/with-contenv bashio

set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-/data}"

if ! bashio::fs.directory_exists "${CONFIG_DIR}"; then
  bashio::log.info "Creating config directory at ${CONFIG_DIR}"
  mkdir -p "${CONFIG_DIR}"
fi
