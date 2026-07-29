# Integrating with sonn core

How to read and control sonn core from your own software — a home-automation system, a
script, a wall display, a plugin.

The API below is the server's own: stable, versionless by design (additive changes only),
and it speaks its own vocabulary. You do not need to know anything about Loxone to use it,
and it works whether or not the Loxone integration is enabled.

Base URL: `http://<server>:7090`

> **Not to be confused with `/admin/api`.** That is the back end of this server's own
> admin UI: it is UI-shaped, changes freely, and is not a contract. Build your integrations on `/api`.

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

And you no longer need to poll: subscribe to `/api/events` and the same data
arrives on every change.

## Design

Two rules explain every choice below:

- **Reading state never requires polling.** Subscribe to `/api/events` once and you are
  told about every change. `GET /api/zones` exists to bootstrap or for one-shot scripts.
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
  "repeat": "off",
  "shuffle": false,
  "track": {
    "title": "Song",
    "artist": "Artist",
    "album": "Album",
    "coverUrl": "http://server:7090/streams/3/…/cover"
  },
  "source": { "kind": "track", "name": "Library", "id": "library://track/9" },
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
| `volume` | number | `0`–`100`. |
| `repeat` | `off` \| `one` \| `all` | |
| `shuffle` | boolean | |
| `track` | object \| **null** | `null` when the zone has nothing loaded. |
| `source` | object \| **null** | Where the audio comes from. |
| `group` | object \| **null** | `null` when the zone plays on its own; `members` lists leader first. |
| `output` | object \| **null** | `protocol` is e.g. `sendspin`, `snapcast`, `googlecast`, `dlna`, `sonos`, `airplay`. |

`source.kind` is one of `track`, `radio`, `playlist`, `linein`, `airplay`, `spotify`,
`bluetooth`, `unknown`. **Treat the list as open**: new kinds may be added, and a client
must not fail on one it does not recognise — that is what `unknown` is a placeholder for.

`source.id` is an **opaque** provider-native identifier. You may store it and pass it
back, but do not parse it: its internal form is service-specific and explicitly not part
of this contract.

`null` is used deliberately instead of empty strings, so `if (zone.track)` is enough to
tell "playing something" from "idle".

## Events

```
GET /api/events        →  text/event-stream
```

Server-Sent Events. Every message is a JSON object on a `data:` line with a `type`
discriminator. The stream opens with a full snapshot, so a client can render before the
first change arrives. A `: keep-alive` comment is sent every 25 s.

```
data: {"type":"server.ready","zones":[ … ]}

data: {"type":"zone.changed","zone":{ … }}
```

`zone.changed` always carries the **complete zone**, never a patch — you never need to
keep prior state to interpret an event, and a client that reconnects is immediately
correct.

Browser:

```js
new EventSource('http://server:7090/api/events')
  .onmessage = (e) => console.log(JSON.parse(e.data));
```

Shell:

```bash
curl -N http://server:7090/api/events
```

## Reading

```
GET /api/zones            →  { "zones": [ … ] }
GET /api/zones/{id}       →  { … }              404 zone-not-found
GET /api/health           →  { "status": "ok", "version": "…", "uptimeSec": 120 }
```

## Commands

All return **`204 No Content`** on success. The resulting state arrives over
`/api/events`.

```
POST /api/zones/{id}/play
POST /api/zones/{id}/pause
POST /api/zones/{id}/stop
POST /api/zones/{id}/next
POST /api/zones/{id}/previous

PUT  /api/zones/{id}/volume     {"volume": 40}   or  {"delta": -5}
PUT  /api/zones/{id}/position   {"position": 90}
PUT  /api/zones/{id}/power      {"power": "on"}
```

`volume` takes either an absolute value (`0`–`100`, clamped) or a signed `delta`. Use
`delta` for remote-control style stepping: it avoids the read-then-write race that two
clients adjusting the same zone would otherwise hit.

Errors are `4xx` with `{"error":"…"}`: `zone-not-found`, `invalid-json`,
`invalid-volume`, `invalid-position`, `invalid-power`, `method-not-allowed`.

## Examples

```bash
# What is playing everywhere?
curl -s http://server:7090/api/zones | jq -r '.zones[] | "\(.name): \(.track.title // "—")"'

# Pause the kitchen, then turn it down a notch
curl -X POST http://server:7090/api/zones/3/pause
curl -X PUT http://server:7090/api/zones/3/volume -d '{"delta":-5}'

# Follow every change
curl -N http://server:7090/api/events
```

## Notes for integrators

- **CORS** is open (`Access-Control-Allow-Origin: *`), so browser clients work directly.
- The API is **unauthenticated on the LAN**, like the other device-facing surfaces on
  port `7090`. Do not expose port `7090` to the internet.
- The API works **with or without the Loxone integration enabled** — it is not a Loxone
  surface and does not depend on one.
- Additive changes (new fields, new `source.kind` values, new event types) are **not**
  breaking. Ignore fields and event `type`s you do not know.

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
