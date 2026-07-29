# sonn core

**sonn core** is a complete multiroom audio solution: a TypeScript audio server that collects your
music — local files, streaming services, radio, line-in — and plays it in sync on the speakers you
already own, over almost any protocol they speak.

It also includes a complete Loxone Audio Server implementation, so a Miniserver can drive it exactly
like the real thing.

> **Status: 4.0 beta.** In active use and actively developed. Releases are tagged from the `beta`
> branch, and breaking changes can still land between betas — check the release notes before updating.

<!-- Screenshot: the Content screen with a populated library, and the Players screen with a few
     players assigned to different output types. Save under .github/images/ and uncomment. -->
<!-- ![The Content screen in the Admin UI](.github/images/admin-content.png) -->

## How it fits together

sonn core has three sides, each configured independently in the Admin UI:

| | What it is | Required? |
| --- | --- | --- |
| **Content** | Where the music comes from: local library, Spotify, Apple Music, Tidal, Deezer, radio, line-in | Yes |
| **Access** | How other apps and devices reach the server: DLNA/UPnP, Subsonic API, network drive, Loxone | Pick at least one way to listen |
| **Players** | Fixed zones this server drives itself, each with one output | Optional |

Content plus Access is already a working audio server. Point a DLNA TV or a Subsonic app at it and
browse your library, Apple Music or Tidal straight from the device — no players involved, and nothing
to configure per room.

Players are for the other model: **fixed zones that this server owns and controls centrally.** Add
them when you want to name your rooms, group them to play in sync, and drive them from one place —
or when you want to give a device features it has no support for itself (see
[Receivers](#receivers)).

The Loxone integration is player-driven, so there players are always on: the Miniserver supplies the
zones and expects to control them.

## Content

Sources are configured under **Content**, and every source is available to every consumer of the
server — the web player, Loxone, DLNA devices and Subsonic apps alike.

### Local library

- Local folders and mounted network shares (SMB/CIFS)
- Tag-based index (albums, artists, tracks, folders) in SQLite, with cover art
- Artist pictures fetched automatically from MusicBrainz → Wikidata → Wikimedia Commons (no API key)
- Incremental indexing: a dropped or copied file is picked up on its own, without a full rescan
- Browse, search and delete tracks from the Admin UI
- Add music by drag-and-drop in the browser, or by mounting the folder as a network drive (see Access)

### Streaming services

- **Spotify** — first-class, multi-account
- **Apple Music**, **Tidal**, **Deezer**, **YouTube Music**, **YouTube**, **SoundCloud**
- **Music Assistant** (as a source, exposing its own providers)

Each configured account becomes its own browsable service, so several accounts of the same service can
coexist. The Loxone integration presents non-Spotify services to the Miniserver as virtual Spotify
accounts, since that is the only vocabulary the Loxone clients have for them; everywhere else they
appear under their own name.

### Radio

- **TuneIn** directory
- **Radio Paradise** (toggleable)
- Custom radio streams you manage yourself

### Line-in

Play a turntable, CD player or any other analog or digital source through your zones, with optional
Shazam track recognition. Play, pause and track skip are routed to the device that owns the source, so
a connected CD changer can be operated from the app.

Line-in needs a **separate helper**, `lox-linein-bridge`: a small Linux program that captures the audio
and sends it to this server. It runs on the machine the source is plugged into — typically a Raspberry
Pi or similar board next to the equipment — and is distributed as a prebuilt binary for x86-64 and ARM.
It finds the server and registers itself, so there is nothing to configure by hand; once it has
registered, its inputs appear under Content.

### Alert engine

- Text-to-speech, using the built-in engine or LoxBerry TTS over MQTT
- Built-in alert sounds
- Native Loxone alerts when the integration is on

## Players

Players are optional. Skip this section entirely if you only want to serve your content to other apps
and devices — that is what Access does. Loxone is the exception: it drives players by design, so with
the Loxone integration on, players are always active and come from the Miniserver.

A player is a fixed zone — one room, one device — that this server owns and controls. Adding players
gets you:

- **Central control**: every zone in one place, in the web player, the Admin UI, or a Loxone app
- **Grouping**: several players in sync
- **Receivers**: features on a device that it doesn't support natively (see below)

Each player has exactly one output, plus:

- Per-player equalizer, volume limits, recents and favorites
- Optional power management (GPIO or USB HID relay), individually or per shared amp/PSU group

You can add up to 24 players, the same ceiling a Loxone Audio Server has.

### Outputs

- Google Cast (Chromecast)
- Sonos
- AirPlay
- DLNA / UPnP renderers
- Snapcast
- Sendspin
- Squeezelite
- Spotify Connect
- Music Assistant players

### Receivers

A receiver lets a phone or app play *to* a player. The server accepts the stream and sends it on to
that player's output, which means the device itself needs no support for the protocol: point AirPlay
or Spotify Connect at a pair of Snapcast speakers or an old amplifier on a line-out, and it works.

- Spotify Connect
- AirPlay
- DLNA
- Line-in
- Music Assistant

### Bang & Olufsen remotes

A player can be controlled with a **Beoremote One**. The server builds the menu the remote shows —
your favorites, radio stations, and any line-in devices such as a turntable or CD player — and each of
the coloured and dot buttons starts something in that room. Play, pause and track skip are routed to
whatever the room is playing, including a line-in device that can be controlled. Volume stays on the
device itself, so it keeps working even if the server is briefly unreachable.

Like line-in, this needs a **separate helper** — the remote pairs with it over Bluetooth, and it
forwards the keypresses to this server. It registers itself the same way, so once it is running you
only pick which remote belongs to which player in the Admin UI.

Under **Players** you pick one of three arrangements, and can change it later:

- **Disabled** — no players. The server shares your content through Access only. This is how a fresh
  install starts.
- **Set up here** — you add players yourself: speakers and rooms you name, group and cast to.
- **Loxone integrated** — your Miniserver pushes which players exist and their names; you still
  configure each one's output and receivers here.

## Access

Everything under **Access** is off by default and independent of the others. Turn on what you need.

### Loxone Audio Server

A complete Loxone Audioserver implementation: pair it with a Miniserver and it behaves like the real
thing — zones, sources, favorites, alerts and the native Loxone app. Enabling or disabling it starts
and stops only the Loxone protocol stack, so it takes effect without a restart.

### DLNA / UPnP MediaServer

Publishes everything the server offers — including streaming services — to any DLNA client on the
network: smart TVs, receivers, network speakers. Albums, artists and playlists are announced with
their real UPnP classes, and UPnP Search is supported.

### Subsonic API

The same content served as an authenticated REST API at `/rest/*`, so apps like Symfonium, Amperfy or
DSub can browse and stream the whole server. Sign in with a local account.

### Network drive (WebDAV)

Mounts the music folder on your computer as a network drive at `/dav`, so albums can be dragged in and
organised with Finder or Explorer. Uses HTTP Basic against the same local accounts. New files are
indexed automatically. Off by default — it is a writable share.

### Web player

A built-in web player is served alongside the Admin UI, so any browser on the network can control
playback and see what's playing.

### Your own software

sonn core has its own HTTP API at `/api` for reading zone state and controlling playback, plus a
live event stream so you never have to poll. It speaks its own vocabulary and works with or without
the Loxone integration. Unlike the rest of this section it needs nothing switched on — it is always
available. See **[Integrating with sonn core](INTEGRATING.md)**.

## Users and authentication

sonn core has its own local user store. The first launch asks you to create an admin account, and
sessions persist across restarts. The Subsonic API and the network drive authenticate against these
same accounts. When the Loxone integration is connected, Miniserver credentials work as an additional
login.

## Requirements

- **Docker** (recommended) — the quickest way to run the server. The repository includes a
  `docker-compose.yml` for one-command startup. It can also run directly on Node.js 20 or newer.
- **Port `7090`** free on the host. The Loxone integration additionally uses `7091` and `7095`, but only
  while it is enabled.
- A **Linux host** if you want to mount a network share as your music library — this needs Unix mount
  tooling such as `mount.cifs`. On Windows, point the library at a local folder instead.

| Port | Used for | When |
| --- | --- | --- |
| `7090` | Admin UI, web player, public API, Subsonic API, WebDAV, DLNA, audio streams | Always |
| `7091` | Loxone native app protocol | Loxone integration enabled |
| `7095` | Loxone Miniserver protocol | Loxone integration enabled |

## Quick Start

```bash
docker compose up -d
```

That starts a container named `sonn-core` in **host network mode**, which is what lets the server
discover Sonos, Chromecast, AirPlay and DLNA devices on your network without extra flags. Because host
mode bypasses port publishing, make sure ports `7090`, `7091` and `7095` are free on the host.

To keep your configuration and library across restarts, add a bind mount to the service in
`docker-compose.yml`:

```yaml
    volumes:
      - ./data:/app/data
```

Everything the server stores lives in that one folder. Back it up and you have backed up the install.

Prefer `docker run`?

```bash
docker run -d \
  --name sonn-core \
  --network host \
  -v $(pwd)/data:/app/data \
  ghcr.io/sonn-audio/core:latest
```

Then open `http://<server-ip>:7090` and continue below.

### Building the image yourself

`docker compose up -d` always pulls the published image and never builds, so it works on a host without
the source checkout. If you have this repository checked out and want to build locally instead, layer
the build override on top:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose up -d
```

### Bridge networking

Host networking is recommended because discovery — how the server finds Sonos, Chromecast, AirPlay and
DLNA devices — needs it. On bridge networking, expect to assign some outputs by IP by hand. Drop
`--network host` and publish the ports instead:

```bash
-p 7090:7090 -p 7091:7091 -p 7095:7095
```

### Running without Docker

Needs Node.js 20 or newer (Docker images and CI build on Node 24) and npm.

```bash
git clone https://github.com/sonn-audio/core.git
cd core
mkdir -p data          # config, logs and cache live here
npm install
npm run build
npm start
```

## Switching amplifiers on and off

A player can switch an amplifier or power supply on when it starts and off after it stops, over either
a GPIO line (using libgpiod's `gpioset`) or a USB HID relay board (CRelay). Configure it per player
under Players.

**From Docker**, the container needs access to the host devices, or calls that work on a host shell will
still fail inside the container. Expose the relevant `/dev/gpiochip*` and/or `/dev/hidraw*` entries, or
run the container with elevated device access.

**GPIO line offsets** are the most common source of trouble: configure the `chip` plus the line offset
*within that chip*. On a Raspberry Pi 4, header GPIO22 is typically line `22` on `/dev/gpiochip0`. The
old sysfs-style global number such as `534` is not what `gpioset` expects, and a correctly wired relay
will do nothing.

**Shared amps and PSUs** — when several players share one amplifier, switch it as a group instead of per
player. Configure the group under `groups.powerGroups[]`, set each player's
`powerManager.powerGroupId` to that group id, and give the group its own `powerManager.gpio` or
`powerManager.crelay`. The shared output turns on while any member is active and off after the last one
stops.

Timing options worth knowing: `activeModes` sets which states count as active (default `['play']`, so
pause switches off), `playbackPreDelayMs` inserts a pre-delay so an amp can wake before the first sound,
and `offDelayMs` delays switching off so short gaps don't cycle the amplifier (default 5 minutes, or set
`offDelayEnabled: false` for immediate).

## Configuring

Open the Admin UI at `http://<server-ip>:7090`. On first launch it asks you to create an admin account.
A fresh install has no players and nothing shared yet, so:

1. **Content** — add your music: point the library at a folder or share, connect a streaming account,
   set up radio.
2. **Access** — turn on how you want to reach it. Switch on DLNA or the Subsonic API and your content
   is immediately browsable from a TV, receiver or phone app.
3. **Players** — only if you want fixed zones this server drives itself. Choose how players are set up,
   add one, and assign its output.

Steps 1 and 2 are enough for a content server. Step 3 is required only for Loxone, which supplies its
own players.

### Enabling the Loxone integration

Under **Players**, choose **Loxone integrated**. The server starts listening immediately, then:

1. Add the AudioServer in Loxone Config using the serial and host shown in the Admin UI.
2. Split the stereo outputs into 4 zones and drag them into your project.
3. Deploy the changes and reboot the Miniserver to start pairing.

When pairing succeeds, the Audio Server icon in Loxone Config turns green and the Miniserver pushes its
zones. You still configure each player's output and receivers in the Admin UI.

Any players you set up yourself are kept while Loxone is connected and return when you disconnect.
Disconnecting takes effect without a restart.

---

Need help or found a bug? Open an issue in the repository.
