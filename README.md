# lox-audioserver

Modern TypeScript implementation of the **Loxone Audio Server**, providing a full functional emulation with extended capabilities and external service bridging.

## Core Features

- **Radio support** backed by TuneIn  
- **Custom radio stream management**
- **Local music library**
  - File storage
  - Shared network drives
- **Per-zone recents and favorites**
- **Multi-account Spotify support**
- **Alert engine**
  - Native Loxone alerts
  - Text-to-Speech (TTS)

## Audio Inputs

- Spotify Connect
- AirPlay
- Line-in

## Bridge Providers

To expose unsupported services to Loxone, *lox-audioserver* introduces **bridge providers**.

A bridge provider acts as a proxy layer that exposes a non-Spotify service as a **virtual Spotify account**.  
Each bridge maps **one external service to one virtual Spotify account**, allowing Loxone to list and use multiple unsupported sources side by side without conflicts.

### Available Bridge Providers

- Apple Music
- Music Assistant

## Configuration

All features, inputs, and bridge providers are fully configurable through the **Admin UI**.

## Requirements

- Docker (recommended) — easiest way to run the server without building from source.
- docker-compose (optional) — the repository includes a `docker-compose.yml` for one-command startup.
- Make sure host ports `7090`,`7091` and `7095` are available (or adjust host mappings when running the container).
- Network share library support relies on Unix-style mount tooling (e.g., `mount.cifs`); this is not available on Windows hosts.

## Quick Start

The easiest options are `docker-compose` or `docker run`.

### Recommended: docker-compose (one command)

If you have Docker and docker-compose installed you can use the included `docker-compose.yml`:

```bash
docker compose up -d
```

This starts a container named `lox-audioserver` in **host network mode**, which is the simplest way to allow mDNS/UPnP/Snapcast discovery without extra flags. Because host mode bypasses port publishing, make sure ports `7090`, `7091`, and `7095` are free on the host. To persist configuration and library data, add a bind mount to the service in `docker-compose.yml`:

```yaml
    volumes:
      - ./data:/app/data
```

### Quick Docker run

If you prefer `docker run`, host networking is recommended:

```bash
docker run -d \
  --name lox-audioserver \
  --network host \
  -v $(pwd)/data:/app/data \
  ghcr.io/rudyberends/lox-audioserver:latest
```

If you must use bridge networking instead, remove `--network host` and add port mappings `-p 7090:7090 -p 7091:7091 -p 7095:7095`.

### Run standalone by cloning (no Docker)

If you prefer to run the server directly on the host without Docker, follow these steps. This is a minimal "standalone" run and requires Node.js and npm.

Prerequisites

- Node.js 20 or newer
- npm (comes with Node)
- Ports `7090`, `7091` and `7095` available on the host

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

Open the admin UI at http://lox-audioserver-ip:7090 and follow the guided steps. It walks you through adding the Audio Server in Loxone Config, rebooting the Miniserver, pairing, and assigning zones/providers once the MiniServer reconnects.

When the lox-audioserver starts successfully and the Miniserver pairs successfully with the lox-audioserver, the Audio Server icon in Loxone Config turns green.

---

Need help or found a bug? Open an issue in the repository.
