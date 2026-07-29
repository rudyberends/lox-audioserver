# Integrating with sonn core

How to read and control sonn core from your own software — a home-automation system, a
script, a wall display, a plugin.

The API below is the server's own: versioned in the path, additive within a version,
and it speaks its own vocabulary. You do not need to know anything about Loxone to use it,
and it works whether or not the Loxone integration is enabled.

Base URL: `http://<server>:7090/api/v1`

> **Not to be confused with `/admin/api`.** That is the back end of this server's own
> admin UI: it is UI-shaped, changes freely, and is not a contract. Build your integrations on
> `/api/v1`.

### Coming from `/admin/api/zones/states`?

Before this API existed, that was the only way to read what a zone was playing, so
integrations polled it. It is now what it was always meant to be — diagnostics for
our own Admin UI — and the now-playing fields have moved here:

| was | now |
| --- | --- |
| `title`, `artist`, `album` | `track.title`, `track.artist`, `track.album` |
| `coverUrl` / `coverurl` | `track.coverUrl` |
| `station`, `sourceName` | `source.name` (with `source.kind` telling you which) |
| `state` (`play`/`pause`) | `state` (`playing`/`paused`/`stopped`) |
| `powerState` (never actually sent) | `power` (`on`/`off`) |
| `tech`, `system` | stayed — engine internals, not part of this contract |

`tech.player` moved as well: it is `output.device` here, with `mac` renamed to the
protocol-neutral `id`. Same value, same guarantee that an idle zone still reports it.

`PUT`/`GET /admin/api/zones/{id}/equalizer` moved too, to
`/api/v1/zones/{id}/equalizer`. The old path is gone rather than aliased, because nothing
outside our own Admin UI should have to touch `/admin/api`. The request body is
unchanged (`{"bands": [ …10 ]}`); the response drops `ok` and `equalizerSettings` —
a `2xx` already means it worked, and the comma-joined string was only ever there for
the Loxone app.

And you no longer need to poll: subscribe to `/api/v1/events` and the same data
arrives on every change.

## Design

Two rules explain every choice below:

- **Reading state never requires polling.** Subscribe to `/api/v1/events` once and you are
  told about every change. `GET /api/v1/zones` exists to bootstrap or for one-shot scripts.
- **Commands are plain HTTP.** No handshake, no socket, no correlation ids — a `curl`
  one-liner or a five-line shell script is a first-class client.

Every successful command is followed by a `zone.changed` event. You never have to read
back after writing.

## Zone object

```json
{
  "id": 3,
  "name": "Kitchen",
  "state": "playing",
  "power": "on",
  "position": 43,
  "duration": 210,
  "volume": 40,
  "volumeLimits": { "max": 70, "default": 20, "step": 2 },
  "repeat": "off",
  "shuffle": false,
  "track": {
    "title": "Song",
    "artist": "Artist",
    "album": "Album",
    "coverUrl": "http://server:7090/streams/3/…/cover"
  },
  "source": { "kind": "track", "name": "Library", "id": "library://track/9", "seekable": true },
  "group": { "leader": 3, "members": [3, 7] },
  "output": { "protocol": "sendspin" }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | Zone id. Stable across restarts. |
| `name` | string | Zone name as configured. |
| `state` | `playing` \| `paused` \| `stopped` | |
| `power` | `on` \| `off` | |
| `position` | number | Whole seconds into the current track. |
| `duration` | number | Whole seconds. `0` means open-ended (live radio). |
| `volume` | number | `0`–`100`, but see `volumeLimits`. |
| `volumeLimits` | object | `max`, `default` and `step` — what this zone's volume will actually accept. |
| `repeat` | `off` \| `one` \| `all` | |
| `shuffle` | boolean | |
| `track` | object \| **null** | `null` when the zone has nothing loaded. |
| `source` | object \| **null** | Where the audio comes from. |
| `group` | object \| **null** | `null` when the zone plays on its own; `members` lists leader first. |
| `output` | object \| **null** | `protocol` is e.g. `sendspin`, `snapcast`, `googlecast`, `dlna`, `sonos`, `airplay`. |

`output.device` is present when the protocol identifies a specific device — for
squeezelite that is the SlimProto MAC, i.e. what its `-m` is set to:

```json
"output": {
  "protocol": "squeezelite",
  "device": { "id": "02:8C:54:A9:DC:AC", "name": "Test1", "connected": true }
}
```

It is reported whether or not the zone is playing and whether or not the device is
reachable, so you can map your own devices onto zones from a single read. `connected`
tells you the current link state; the id stays put either way.

`source.kind` is one of `track`, `radio`, `playlist`, `linein`, `airplay`, `spotify`,
`bluetooth`, `unknown`. **Treat the list as open**: new kinds may be added, and a client
must not fail on one it does not recognise — that is what `unknown` is a placeholder for.

`source.seekable` says whether `PUT /zones/{id}/position` will do anything — false for a
live stream, which has no position to seek to.

`source.id` is an **opaque** provider-native identifier. You may store it and pass it
back, but do not parse it: its internal form is service-specific and explicitly not part
of this contract.

`null` is used deliberately instead of empty strings, so `if (zone.track)` is enough to
tell "playing something" from "idle".

## Events

```
GET /api/v1/events        →  text/event-stream
```

Server-Sent Events. Every message is a JSON object on a `data:` line with a `type`
discriminator. The stream opens with a full snapshot, so a client can render before the
first change arrives. A `: keep-alive` comment is sent every 25 s.

```
data: {"type":"server.ready","zones":[ … ]}

data: {"type":"zone.changed","zone":{ … }}

data: {"type":"zone.progress","id":3,"position":44}
```

`zone.changed` always carries the **complete zone**, never a patch — you never need to
keep prior state to interpret an event, and a client that reconnects is immediately
correct.

`zone.progress` is the one exception: while a track plays and nothing but the clock has
moved, only the new position is sent. A full zone is ~550 bytes and this fires once a
second per playing zone. Anything else that changes — volume, a new track, a source
switch — still arrives as a `zone.changed`, so **a client that ignores
`zone.progress` stays correct**; its progress bar just moves a beat later.

Browser:

```js
new EventSource('http://server:7090/api/v1/events')
  .onmessage = (e) => console.log(JSON.parse(e.data));
```

Shell:

```bash
curl -N http://server:7090/api/v1/events
```

## Reading

```
GET /api/v1/zones                   →  { "zones": [ … ] }
GET /api/v1/zones/{id}              →  { … }              404 zone-not-found
GET /api/v1/zones/{id}/equalizer    →  { "zoneId": 3, "bands": [ …10 ] }
GET /api/v1/health                  →  { "status": "ok", "version": "…", "uptimeSec": 120 }
```

## Commands

All return **`204 No Content`** on success. The resulting state arrives over
`/api/v1/events`.

```
POST /api/v1/zones/{id}/play
POST /api/v1/zones/{id}/pause
POST /api/v1/zones/{id}/stop
POST /api/v1/zones/{id}/next
POST /api/v1/zones/{id}/previous

PUT  /api/v1/zones/{id}/volume     {"volume": 40}   or  {"delta": -5}
PUT  /api/v1/zones/{id}/position   {"position": 90}
PUT  /api/v1/zones/{id}/power      {"power": "on"}
PUT  /api/v1/zones/{id}/equalizer  {"bands": [3,3,2,1,0,0,-1,-2,-2,-3]}
```

`volume` takes either an absolute value (`0`–`100`) or a signed `delta`. Use `delta` for
remote-control style stepping: it avoids the read-then-write race that two clients
adjusting the same zone would otherwise hit, and `volumeLimits.step` is the size a step
should have.

A zone can be capped: writing above `volumeLimits.max` lands on the cap rather than
where you asked, so render your slider against `max` instead of against 100.

`equalizer` takes ten gains in dB, low band first, clamped to `-6`..`+6` — the same
range the Loxone app uses. It replies `200` with the applied bands rather than `204`,
since a clamped value is worth seeing. Unlike the transport verbs it is configuration,
so it works on an idle zone too.

If you are an **equalizer provider** — you run the actual DSP and want the server to
reflect it — write here when your own UI changes, and read here to pick up changes made
elsewhere. The server does not push your change back to you.

Errors are `4xx` with `{"error":"…"}`: `zone-not-found`, `invalid-json`,
`invalid-volume`, `invalid-position`, `invalid-power`, `invalid-equalizer-bands`,
`method-not-allowed`.

## Examples

```bash
# What is playing everywhere?
curl -s http://server:7090/api/v1/zones | jq -r '.zones[] | "\(.name): \(.track.title // "—")"'

# Pause the kitchen, then turn it down a notch
curl -X POST http://server:7090/api/v1/zones/3/pause
curl -X PUT http://server:7090/api/v1/zones/3/volume -d '{"delta":-5}'

# Follow every change
curl -N http://server:7090/api/v1/events
```

## Notes for integrators

- **CORS** is open (`Access-Control-Allow-Origin: *`), so browser clients work directly.
- The API is **unauthenticated on the LAN**, like the other device-facing surfaces on
  port `7090`. Do not expose port `7090` to the internet.
- The API works **with or without the Loxone integration enabled** — it is not a Loxone
  surface and does not depend on one.
- Additive changes (new fields, new `source.kind` values, new event types) are **not**
  breaking. Ignore fields and event `type`s you do not know.
- **The version is in the path.** Within `v1`, fields are only ever added — nothing is
  renamed or removed under you. Anything that has to break appears as `v2`, served
  alongside `v1` rather than replacing it, so you migrate when it suits you. Calling
  `/api/...` without a version returns `404 api-version-required` and names the prefix
  to use, rather than failing in some way you have to guess at.

## Choosing the right surface

`/api` is for controlling the server. For content, existing protocols usually get you
further — a Subsonic app already does browsing, search and offline sync, and you would be
rebuilding it. See [Access](README.md#access) for how to enable each of these.

| Surface | Use it for |
| --- | --- |
| `/api` | Reading zone state and controlling playback — start here |
| Subsonic (`/rest/*`) | Browsing and streaming the library with existing apps |
| DLNA / UPnP | Renderers, and discovery by TVs and network speakers |
| WebDAV (`/dav`) | Adding and organising files in the library |
| Loxone (`7091`/`7095`) | The Loxone Miniserver and native app only — not a general API |
