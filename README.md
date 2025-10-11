# lox-audioserver

> ⚠️ **Attention**
>
> Loxone is preparing to release a new version of their client applications.  
> On some items these updated clients communicate with the Audio Server in a different way compared to the current versions.  
> The overall look and feel have also been redesigned.
>
> As the current clients will soon be considered *legacy*, this server’s main focus is towards supporting the new generation of clients.  
>
> If you encounter any issues, please also test whether the problem can be reproduced using the latest beta clients, available here:  
> 👉 [https://www.loxone.com/enen/support/downloads/](https://www.loxone.com/enen/support/downloads/)

Modern TypeScript implementation of the Loxone Audio Server that lets you run your own
player backends (required) and, optionally, media providers while keeping the Miniserver API
happy. It exposes the same HTTP/WebSocket surface as the original firmware so existing apps,
Touch/Miniservers, and integrations can keep talking to it without modification.

## Features

- Zone backends
  - 🎧 Music Assistant backend — Controls Music Assistant players; supports multiple players per server. (Set `maPlayerId` per zone in the admin UI.)
  - 🔊 BeoLink backend — Integrates with Bang & Olufsen BeoLink devices. Typically one device per zone via its IP.
  - 📦 Sonos / Example backend — Stub/sample implementation to demonstrate how to integrate additional clients; extend this for real Sonos support.

- Media providers (optional)
  - 📻 Music Assistant provider — Full library, radio and playlist browsing and playback via Music Assistant.
  - 🧪 BeoLink provider — Only radio support.
  - ⚙️ Dummy provider — Returns empty lists for library/radio/playlist requests so clients remain responsive when no provider is configured (Default provider).

- Extensible core
  - 🧩 Clean separation between HTTP/WebSocket routing, media providers, and zone backends to make adding new integrations straightforward.

You can configure backends and providers via the admin UI; see the `Configuration Overview` below for pointer to `data/config.json` and per-backend notes.

## Requirements

- Docker (recommended) — easiest way to run the server without building from source.
- docker-compose (optional) — the repository includes a `docker-compose.yml` for one-command startup.
- Make sure host ports `7091` and `7095` are available (or adjust host mappings when running the container).

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

Open the admin UI at http://<lox-audioserver-ip>:7091/admin and follow the guided steps. It walks you through adding the Audio Server in Loxone Config, rebooting the Miniserver, pairing, and assigning zones/providers once the MiniServer reconnects.

When the lox-audioserver starts successfully and the Miniserver pairs successfully with the lox-audioserver, the Audio Server icon in Loxone Config turns green.

## Code Structure

```
src/
  backend/           // Zone backends (Music Assistant, Beolink, Sonos stub, examples)
  backend/provider/  // Media providers and provider factory
  http/              // HTTP + WebSocket routing layer
  config/            // Miniserver/audio-server configuration handling
  utils/             // Logging and helpers
```

- **HTTP layer** (`src/http/handlers`) contains typed route handlers grouped by concern
  (`config`, `provider`, `zone`, `secure`). `requesthandler.ts` wires them into the Loxone
  command router used by both HTTP and WebSocket paths.
- **Providers** expose radios/playlists/library folders. The Music Assistant provider uses
  dedicated services for radio, playlist, and library browsing.
- **Zone backends** translate Loxone player commands into backend-specific APIs.

## Extending the Server

- **Add a new zone backend**: create a subclass of `Backend` under
  `src/backend/zone/<YourBackend>`, implement the required methods (`initialize`,
  `sendCommand`, etc.), then register it in `backendFactory.ts`. Remember: backends only control
  client devices; media browsing is provided separately by the media provider.
- **Add a new media provider**: implement the `MediaProvider` interface under
  `src/backend/provider`, register it in `provider/factory.ts`, and document configuration
  variables. Ensure the designated zone backends understand the provider’s playback semantics
  (e.g., Music Assistant provider pairs with `BackendMusicAssistant`). Mixing incompatible
  providers/backends is not supported.

## Contributing

Pull requests are welcome. Full contribution guidelines (commit message conventions, PR flow and release rules) are in `CONTRIBUTING.md`.

- Make a feature branch from `beta` (or `main` when appropriate):
  `git checkout -b feature/your-feature-name`
- Follow Conventional Commits for message formatting (commitlint will reject non-conforming messages).
- Push your branch and open a PR targeting `beta` for testing: `gh pr create --base beta --head feature/your-feature-name`.

Run `npm run build` locally before submitting a PR to keep compiled output in sync.

---

Need help or found a bug? Open an issue in the repository.
