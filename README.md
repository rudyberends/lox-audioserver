# lox-audioserver

Modern TypeScript implementation of the Loxone Audio Server that lets you run your own
player backends (required) and, optionally, media providers while keeping the Miniserver API
happy. It exposes the same HTTP/WebSocket surface as the original firmware so existing apps,
Touch/Miniservers, and integrations can keep talking to it without modification.

## Features

- Adapters
  - 🎧 Music Assistant — Controls Music Assistant players and use content from the musicassistant server.
  - 🔊 BeoLink — Integrates with Bang & Olufsen BeoLink devices. Typically one device per zone via its IP.

- Extensible core
  - 🧩 Clean separation between HTTP/WebSocket routing, media providers, and adapters to make adding new integrations straightforward.

You can configure zones and provider via the admin UI.

## Requirements

- Docker (recommended) — easiest way to run the server without building from source.
- docker-compose (optional) — the repository includes a `docker-compose.yml` for one-command startup.
- Make sure host ports `7090`,`7091` and `7095` are available (or adjust host mappings when running the container).

## Quick Start

The easiest options are `docker-compose` or `docker run`.

### Recommended: docker-compose (one command)

If you have Docker and docker-compose installed you can use the included `docker-compose.yml`:

```bash
docker compose up -d
```

This starts a container named `lox-audioserver` and exposes the required ports (`7091`, `7095`).

### Quick Docker run

If you prefer `docker run`:

```bash
docker run -d \
  --name lox-audioserver \
  -p 7091:7091 \
  -p 7095:7095 \
  -v $(pwd)/data:/app/data \
  ghcr.io/rudyberends/lox-audioserver:latest
```

This starts a container named `lox-audioserver` and exposes the required ports (`7091`, `7095`).

### Run standalone by cloning (no Docker)

If you prefer to run the server directly on the host without Docker, follow these steps. This is a minimal "standalone" run and requires Node.js and npm.

Prerequisites

- Node.js 20 or newer
- npm (comes with Node)
- Ports `7091` and `7095` available on the host

Step-by-step

1. Clone the repository and change directory:

```bash
git clone https://github.com/rudyberends/lox-audioserver.git
cd lox-audioserver
```

2. Create a persistent data folder (used for config, logs, and cache):

```bash
mkdir -p data
```

3. Install dependencies and build:

```bash
npm install
npm run build
```

4. Start the server:

```bash
npm start
```

### Configuring

Open the admin UI at http://<lox-audioserver-ip>:7090 and follow the guided steps. It walks you through adding the Audio Server in Loxone Config, rebooting the Miniserver, pairing, and assigning zones/providers once the MiniServer reconnects.

When the lox-audioserver starts successfully and the Miniserver pairs successfully with the lox-audioserver, the Audio Server icon in Loxone Config turns green.

---

Need help or found a bug? Open an issue in the repository.
