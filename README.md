# lox-audioserver

Modern TypeScript implementation of the Loxone Audio Server that lets you run your own
player backends (required) and, optionally, media providers while keeping the Miniserver API
happy. It exposes the same HTTP/WebSocket surface as the original firmware so existing apps,
Touch/Miniservers, and integrations can keep talking to it without modification.

The project currently ships with working Bang & Olufsen BeoLink and Music Assistant support, but the modular design makes it straightforward to plug in other systems.

## Features

- 🎧 **Zone backends**: Music Assistant, Beolink, and a stub Sonos implementation that
  demonstrates how to integrate additional clients.
- 📻 **Media providers (optional)**: Music Assistant provider with full library/radio/playlist
  support. If no provider is configured, the built-in dummy provider returns empty lists so
  clients remain responsive.
- 🧩 **Extensible core**: Clean separation between request routing, providers, and zone
  backends to make future integrations easy.

## Requirements

- Node.js **20** or newer (the repo uses `@tsconfig/node20`).
- npm (ships with Node) for dependency management.
- A configured Loxone Miniserver if you want to pair with real hardware.
- Easiest deployment: use the published Docker image (see [Quick Start](#quick-start)).

## Quick Start

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Build**

   ```bash
   npm run build
   ```

3. **Run**

   ```bash
   npm start
   ```

   The server exposes two endpoints by default:

   - `7091` – `AppHttp` (used by Loxone apps / WebSocket clients and the admin UI).
   - `7095` – `msHttp` (used by the Miniserver itself).

   During development you can use the watcher to run TypeScript directly:

   ```bash
   npm run watch
   ```

5. **Run via Docker (from GitHub Container Registry)**

   Every release publishes a multi-arch image to GHCR. Replace `VERSION` with a published tag
   (or use `latest`).

   ```bash
   docker run \
     -p 7091:7091 \
     -p 7095:7095 \
     -v $(pwd)/data:/data \
     ghcr.io/rudyberends/rudyberends/lox-audioserver:VERSION

   The workflow `.github/workflows/create-release-and-build.yml` bumps the version, builds,
   and pushes the image automatically whenever changes land on `main`.

## Configuring

Open the admin UI at `http://<lox-audioserver-ip>:7091/admin` and follow the guided steps. It walks you through adding the Audio Server in Loxone Config, rebooting the Miniserver, pairing, and assigning zones/providers once the MiniServer reconnects.

When the lox-audioserver starts successfully and the Miniserver pairs successfully with the lox-audioserver, the Audio Server icon in
Loxone Config turns green.

## Configuration Overview

All settings are stored in `data/config.json`. The
admin UI reads and writes this file for you.

- **Beolink/Sonos backends** expect a one-to-one mapping: each zone points to a dedicated
  device IP.
- **MusicAssistant backend** can control many players on the same server. Set `maPlayerId` for
  each zone using the “Player ID” from Music Assistant → Player settings.

| Zone backend | Compatible provider(s)                   | Notes |
| ------------ | ---------------------------------------- | ----- |
| `BackendMusicAssistant` | `MusicAssistantProvider`, `DummyProvider` | Requires `maPlayerId`; multiple zones can share one MA host. |
| `BackendBeolink`        | `BeolinkProvider`, `DummyProvider`                           | One device per zone via its IP. |
| `BackendSonos` / `BackendExample` | `DummyProvider`                 | Stub/sample implementations; extend to add real provider support. |

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

## Development Notes

- TypeScript sources live in `src/`; compiled output goes to `dist/` via `npm run build`.
- Logging uses a Winston-based logger (`src/utils/troxorlogger.ts`). Log levels are configured
  via the admin UI (stored in `data/config.json`).
- Graceful shutdown signals (`SIGINT`, `SIGTERM`) are handled in `src/server.ts`; staged
  clean-up (zone backends, servers) ensures repeatable restarts.

## Contributing

Pull requests for new providers/backends are welcome. Please run `npm run build` before
submitting to ensure the TypeScript output stays in sync.

---

Need help or discovered a bug? Open an issue in the repository.
