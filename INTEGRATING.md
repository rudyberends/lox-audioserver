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

### Coming from `/admin/api`?

Before this API existed, `/admin/api/zones/states` was the only way to read what a zone was
playing, so integrations polled it. It is now what it was always meant to be — diagnostics
for our own Admin UI — and the now-playing fields have moved here:

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

`GET /admin/api/transports/squeezelite/clients` has an answer here too, if you were using
it to work out which of your players ended up on which zone. `output.device.id` is that
same MAC and `output.device.connected` that same link state, per zone, from one read of
`/api/v1/zones` — see [the zone object](#zone-object). No session, no credentials.

That last part is the point of all of this: **`/admin/api` needs a session and `/api/v1`
does not.** If you are logging in — with local accounts or with Miniserver credentials — to
read state or steer playback, you are on the wrong surface, and the login can go with it.
`/admin/api` is the back end of our own Admin UI: it is UI-shaped, it changes without
notice, and nothing in it is a promise to you.

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
GET /api/v1/zones/{id}/queue        →  { "items": [ … ], "start": 0, "total": 42, "currentIndex": 3 }
GET /api/v1/zones/{id}/favorites    →  { "items": [ … ], "start": 0, "total": 8 }
GET /api/v1/zones/{id}/recents      →  { "items": [ … ], "start": 0, "total": 20 }
GET /api/v1/services                →  { "services": [ … ] }
GET /api/v1/browse                  →  the root: one entry per service
GET /api/v1/browse/{id}             →  { "container": …, "items": [ … ], "start": 0, "total": 42 }
GET /api/v1/items/{id}              →  one item                404 not-found
GET /api/v1/search?q=…              →  { "items": { "track": [ … ] }, … }
GET /api/v1/inputs                  →  { "inputs": [ … ] }
GET /api/v1/health                  →  { "status": "ok"|"degraded"|"unhealthy", … }
GET /api/v1/ready                   →  { "ready": true, "phase": "ready" }   503 when not
GET /api/v1/zones/{id}/cover        →  the image itself        404 when the zone has none
```

### Supervising the server

Two endpoints, because "is it working?" and "can I stop waiting?" are different questions.

`GET /api/v1/ready` is the cheap one — poll it every second if you like:

```json
{ "ready": true, "phase": "ready" }
```

`phase` is `starting`, `ready` or `failed`, and the status code carries the same answer:
**200** when ready, **503** when not. That distinction is the point — a server that is still
booting and one that died during boot both fail to answer, but only the second needs you.
A `failed` phase adds `error` with the reason. This is also what to poll after a restart,
instead of sleeping and hoping.

`GET /api/v1/health` gives a verdict you can act on:

```json
{
  "status": "degraded",
  "version": "4.0.0-beta.17",
  "uptimeSec": 451,
  "phase": "ready",
  "checks": [
    { "name": "audio", "status": "degraded", "detail": "last playback attempt failed on Study (ffmpeg exited 1)" },
    { "name": "loxone", "status": "ok" }
  ]
}
```

Three statuses, and the middle one matters most:

| status | code | what to do |
| --- | --- | --- |
| `ok` | 200 | nothing |
| `degraded` | **200** | look, but do not restart — it is still serving |
| `unhealthy` | 503 | intervene |

`degraded` deliberately stays a 200. The usual reaction to a non-2xx is a restart, and
restarting a server whose Loxone link is down or whose one zone has a failing encoder fixes
nothing while interrupting every zone that was fine. If you want a single boolean for a
`docker healthcheck` or a load balancer, the status code already is one — only `unhealthy`
fails.

`checks[]` is keyed by a stable `name`, so branch on that rather than parsing `detail`
(which is prose, aimed at whoever has to fix it, and may change). Healthy checks carry no
`detail`. A check appears only where it is meaningful: a server no Miniserver has ever
paired with reports no `loxone` check at all, because an absent integration is not a broken
one.

`uptimeSec` counts from when the server last became **ready**, not from process start —
otherwise a restart keeps counting through a window in which nothing was served.

Neither endpoint needs a session.

### Cover art

`track.coverUrl` is the artwork's real location, and it changes every track — it can be a
remote CDN, a data uri, or a url only reachable from the server. That is fine if you read
state and update an `<img>` each time, but not if you want one address you can point a
wall panel or a Loxone visualisation at and forget about.

`GET /api/v1/zones/{id}/cover` is that address. It names only the zone, returns the image
bytes, and follows whatever that zone is playing:

```bash
# Always shows the kitchen's current cover
http://server:7090/api/v1/zones/3/cover
http://server:7090/api/v1/zones/3/cover?size=300
```

`size` is a hint. Where the provider offers variants (Apple Music, TuneIn, the image
proxy) the server asks upstream for one near that size, which is sharper and cheaper than
scaling here; otherwise it is ignored. Out-of-range or unparseable values fall back to the
default rather than erroring, so an `<img src>` that cannot handle a `400` stays safe.

A zone playing nothing, or an unknown zone, answers `404` — draw your own placeholder
rather than expecting a blank image.

#### Keeping it fresh

Because the url does not change when the track does, caching needs a way to tell one cover
from the next. Every response carries an `ETag` hashed from the artwork itself, alongside
`Cache-Control: public, max-age=10`:

```bash
curl -s -o cover.jpg -D - http://server:7090/api/v1/zones/3/cover
# ETag: "xLp3…"

# Still the same cover → 304, no body transferred
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'If-None-Match: "xLp3…"' http://server:7090/api/v1/zones/3/cover
```

So polling costs almost nothing while a track plays, and the moment it changes you get
bytes again. The tag is derived from the source and the requested size, which makes it
stable across restarts and identical on two servers holding the same art — not a counter
you have to store.

Some clients ignore all of that. A Loxone visualisation will hold an `<img src>` far longer
than `max-age` suggests, and there is no header that fixes it. For those, add any parameter
of your own and vary it when the track changes — unknown parameters are ignored:

```
http://server:7090/api/v1/zones/3/cover?v=applemusic:track:b64_MTc4MDM4MjY5NQ==
```

`track.coverUrl` from `/api/v1/events` is a convenient value to put there: it changes
exactly when the picture does.

## Commands

All return **`204 No Content`** on success. The resulting state arrives over
`/api/v1/events`.

```
POST /api/v1/zones/{id}/play    {"uri": "…"}   or  no body to resume
POST /api/v1/zones/{id}/pause
POST /api/v1/zones/{id}/stop
POST /api/v1/zones/{id}/next
POST /api/v1/zones/{id}/previous

PUT  /api/v1/zones/{id}/volume     {"volume": 40}   or  {"delta": -5}
PUT  /api/v1/zones/{id}/position   {"position": 90}
PUT  /api/v1/zones/{id}/power      {"power": "on"}
PUT  /api/v1/zones/{id}/input      {"input": "linein-ms3h9f42"}
PUT  /api/v1/zones/{id}/equalizer  {"bands": [3,3,2,1,0,0,-1,-2,-2,-3]}
PUT  /api/v1/zones/{id}/repeat     {"repeat": "off" | "all" | "one"}
PUT  /api/v1/zones/{id}/shuffle    {"shuffle": true}

POST   /api/v1/zones/{id}/queue    {"uri": "…"}            add to the end
POST   /api/v1/zones/{id}/queue    {"uri": "…", "next": true}   add after what is playing
PATCH  /api/v1/zones/{id}/queue    {"play": "<item id>"}    jump to an entry
PATCH  /api/v1/zones/{id}/queue    {"move": "<id>", "before": "<id>"}   reorder (omit `before` for the end)
DELETE /api/v1/zones/{id}/queue    {"id": "<item id>"}      remove one entry
DELETE /api/v1/zones/{id}/queue    {"all": true}            clear it
DELETE /api/v1/zones/{id}/queue    {"undo": true}           revert the last edit

POST   /api/v1/zones/{id}/alert      {"kind": "tts", "text": "…"}   say or play something
DELETE /api/v1/zones/{id}/alert      {"kind": "alarm"}              stop it

POST   /api/v1/zones/{id}/favorites  {"uri": "…", "name": "…"}   add (name optional)
PATCH  /api/v1/zones/{id}/favorites  {"id": 1, "name": "…"}      rename
PATCH  /api/v1/zones/{id}/favorites  {"order": [3,1,2]}          reorder
PATCH  /api/v1/zones/{id}/favorites  {"play": 1}                 start it
DELETE /api/v1/zones/{id}/favorites  {"id": 1}                   remove
DELETE /api/v1/zones/{id}/recents                                clear the history

PUT    /api/v1/zones/{id}/group      {"members": [7, 9]}   group these behind this zone
PUT    /api/v1/zones/{id}/group      {"members": []}       ungroup
```

`pause` keeps the zone's place and `stop` gives it up: after `pause`, `play` resumes
where it was; after `stop` it starts over. Both let the zone's power management switch
an amplifier off, since by default only `play` counts as active.

Live radio is the exception — it has no position to resume, so `pause` tears the stream
down and `play` reconnects live. Expect `position` to restart at 0 there rather than
continue.

`play` without a body resumes whatever the zone already has queued. With `{"uri": "…"}`
it **starts** something: either a stream URL, or a `source.id` this API gave you
earlier — that is what makes the id worth storing. Resolving it and rebuilding the queue
happens server-side, so you do not need to know anything about how content is modelled.

```bash
# Start a stream, then a track this zone reported playing earlier
curl -X POST http://server:7090/api/v1/zones/3/play -d '{"uri":"http://example/stream.mp3"}'
curl -X POST http://server:7090/api/v1/zones/3/play -d '{"uri":"library://track/9"}'
```

## Browsing

```bash
# What is there?
curl -s http://server:7090/api/v1/services

# Start at the root, then walk in
curl -s http://server:7090/api/v1/browse
curl -s "http://server:7090/api/v1/browse/<id>?offset=0&limit=50"
```

Every service appears **under its own name** — `applemusic`, `soundcloud`, `library`. There
is no Spotify disguise here. That disguise exists because the Loxone clients know exactly
one streaming service; it is a translation in that adapter and it stops there.

### Items

```json
{
  "id": "b1.p.track.YXBwbGVtdXNpYzp0cmFjazpiNjRfYVM1WVRVUldaRUpS…",
  "name": "A Bird In New York",
  "kind": "track",
  "browsable": false,
  "playable": true,
  "service": "applemusic",
  "artist": "Eric Serra",
  "album": "Léon (Original Motion Picture Soundtrack)",
  "duration": 81,
  "coverUrl": "https://…/640x640bb.jpg"
}
```

`kind` is `track`, `album`, `artist`, `playlist`, `radio`, `show`, `episode`, `category`,
`folder` or `unknown`. **Treat the list as open** — new kinds may appear and a client must
not fail on one it does not know.

`browsable` and `playable` are separate questions and both can be true: an album is
something to open *and* something to play, so branch on what the user did rather than
inferring from `kind`.

`id` is **opaque**. Feed it back to `/browse/{id}`, `/items/{id}` or
`POST /zones/{id}/play` — it round-trips exactly. Do not parse it: the encoding is not part
of this contract, and ids stay valid across restarts and library rescans precisely because
they do not encode anything you should rely on.

### Paging

`offset` and `limit` (default 50, max 500). `total` is the number of children — **or `null`
when the provider cannot say**, which several streaming providers genuinely cannot. When it
is null, keep paging until you get back fewer items than you asked for. A number here is a
real count, not an estimate.

### Looking one thing up

```bash
curl -s http://server:7090/api/v1/items/<id>
```

For when you have an id but no listing it came from — a deep link, a restored session, an id
stored last week. One caveat, stated plainly: a container's own name is not always knowable.
Providers name a folder in the *listing that contains it*, not in the folder itself, so
`name` can come back empty for a container you did not browse into. It is never fabricated.

### Search

```bash
curl -s "http://server:7090/api/v1/search?q=beatles"
curl -s "http://server:7090/api/v1/search?q=beatles&kind=album&limit=10"
curl -s "http://server:7090/api/v1/search?q=beatles&service=applemusic,library"
```

```json
{
  "query": "beatles",
  "items": { "track": [ … ], "album": [ … ], "artist": [ … ] },
  "services": [{ "service": "library" }, { "service": "applemusic" }]
}
```

Results are grouped by kind, and every item names the service it came from.

`kind` narrows the search, and it is not merely a filter: a provider that cannot search a
kind is **not asked** for it. Ask for albums and SoundCloud sits it out, because SoundCloud
has no album search — check `searchableKinds` in `/services` to see what each one offers
rather than assuming they are alike. `service` narrows which providers are asked at all.

`services` in the response says who answered, with `failed: true` on any that errored — so
a provider outage looks like a partial answer rather than "no matches".

### Inputs

Physical inputs — a turntable, a CD player, a MasterLink device — are configured in the
admin UI. What is configured is listed here, and there may be none:

```json
{
  "inputs": [
    { "id": "linein-ms3h9f42", "name": "BeoSound 9000", "icon": "cd-player",
      "controllable": true, "reportsMetadata": true }
  ]
}
```

They belong to the server, not to a zone: the same input is selectable from any zone, so
switching one is a property of the zone rather than a list under it.

```bash
curl -X PUT http://server:7090/api/v1/zones/3/input -d '{"input":"linein-ms3h9f42"}'
```

`source.id` reports that same id back once the zone is on it, so what you read is what you
can write. `source.name` is the input's configured name.

`controllable` is worth branching on. For an input that answers commands — something on a
MasterLink bus, say — the ordinary `POST /zones/{id}/pause`, `/next` and so on reach the
device. For a turntable or a bare jack it is `false`: selecting it is the whole
interaction, and transport commands change nothing audible. `reportsMetadata` says whether
`track` will ever be more than blank.

`icon` is a hint for choosing an artwork: `line-in`, `cd-player`, `computer`, `imac`,
`ipod`, `mobile`, `radio`, `screen`, `turntable`. **Treat the list as open.**

There is no verb for leaving an input — selecting something else is how you leave, and the
server releases the old source as part of that.

### Announcements

```bash
# Say something in the kitchen
curl -X POST http://server:7090/api/v1/zones/3/alert \
  -d '{"kind":"tts","text":"Dinner is ready","language":"nl"}'

# The doorbell, everywhere at once
curl -X POST http://server:7090/api/v1/zones/3/alert \
  -d '{"kind":"bell","zones":[7,9]}'

# Your own sound
curl -X POST http://server:7090/api/v1/zones/3/alert \
  -d '{"kind":"url","url":"http://nas/sounds/washer-done.mp3"}'
```

An alert interrupts rather than queues: whatever the zone was playing is ducked and picked
up again afterwards, and the volume comes from that zone's configured alert level — not its
current one, so an announcement is audible in a room someone had turned down.

`kind` is `tts`, `bell`, `alarm`, `fire`, `buzzer` or `url`. `tts` needs `text` and takes an
optional `language`; `url` needs an `http(s)` address this server can reach. `zones` adds
more rooms to the same announcement, with the zone in the path leading it — the response
lists every room it played in.

`volume` (0–100) overrides the zone's alert level for one announcement.

`alarm` and `fire` keep going until stopped, which is what `DELETE` is for. The others end
by themselves.

A `422` means the alerts layer refused it — most often no text-to-speech provider is set up
— with `error` naming the reason. A `2xx` means it started, not that you heard it.

### Favourites, recents and groups

A favourite's `id` is its handle, for renaming, reordering, playing and removing. The
Loxone clients also carry a `slot` and a `plus` flag — a position in their own button
grid — which describe that UI rather than the favourite, so neither appears here.
Reordering is simply the order you send.

Recents are read-only apart from clearing: history has no handle to rename or reorder,
and `source` is what you hand back to `play`.

Grouping answers **200 with the resulting group**, not 204. Frame mirroring works between
outputs of one protocol, so unless the server allows mixed groups a member on another
protocol cannot join — it comes back under `rejected` with a reason, instead of leaving
you to diff what you asked for against the next zone event. An empty `members` list
ungroups; there is no separate verb for leaving.

### The queue

`GET` returns a page: `start` and `limit` (default 100, max 500) are query parameters,
and `total` is the length of the whole queue so you know whether to ask for more.
`currentIndex` is the entry playing now, or `null`.

Each entry has an **`id` that identifies the entry, not the track** — queue the same
track twice and you get two ids. That id is what `play`, `move` and `id` take. `source`
is the same opaque provider id as `ApiSource.id`, so an entry can be re-queued later.

Clearing the queue needs `{"all": true}` rather than an empty body: wiping a queue
should be something you asked for, not something a missing field happened to mean.

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
`invalid-volume`, `invalid-position`, `invalid-power`, `invalid-uri`, `invalid-repeat`, `invalid-shuffle`, `invalid-equalizer-bands`,
`invalid-queue-patch`, `invalid-queue-delete`, `queue-item-not-found`,
`invalid-favorite-patch`, `invalid-favorite-delete`, `invalid-favorite-order`,
`favorite-not-found`, `invalid-members`,
`invalid-alert-kind`, `invalid-text`, `invalid-zones`,
`invalid-input`, `input-not-found`, `invalid-query`,
`method-not-allowed`.

## MQTT

An optional second surface, for setups already built around a broker. It is not a
replacement for the API above: it carries zone state and the everyday transport controls,
and nothing else. Announcements, browsing, the queue, favourites, recents, the equalizer,
grouping, cover art and health checks are HTTP only.

Reach for it when a broker is already how your house talks to itself — then MQTT saves you
writing an HTTP client, and tools like Home Assistant or Node-RED consume it with no code
at all. Reach for the HTTP API when you want the whole feature set, or when adding a broker
would be infrastructure you do not otherwise need. Both can run at once, and both report
the same state: MQTT publishes from the same event source `/api/v1/events` streams from, so
the two cannot disagree.

Switch it on under **Access** in the admin UI and point it at your broker. The payload is
the same zone object described above — the API model, not Loxone's field names.

### What it publishes

```
sonn/server/online              1        (0 when the server dies — this is an MQTT will)
sonn/zones/3                    {"id":3,"name":"Kitchen","state":"playing",…}
sonn/zones/3/state              playing
sonn/zones/3/volume             40
sonn/zones/3/track/title        Song
sonn/zones/3/source/name        Apple Music
sonn/zones/3/output/protocol    sendspin
```

Two shapes on purpose. The `zones/<id>` topic carries the whole object as JSON. The
per-field topics carry plain scalars, because a Miniserver or a KNX gateway can subscribe
to a topic and read a number but cannot parse JSON. Booleans are `1`/`0` for the same
reason, and a field with no value is published empty rather than dropped — so a display
clears when playback stops instead of keeping the last track.

Everything is **retained**, so a consumer that connects later sees current state
immediately instead of waiting for the next change.

`sonn` is the default prefix and is configurable; two servers on one broker need different
ones. The playing-time counter (`position`) is off by default — it costs a message per
second per zone — and can be switched on in the same panel.

### Controlling it

Publish to `set/<field>` for a single value, or to `cmd` with JSON when you need more than
one at once:

```bash
mosquitto_pub -t 'sonn/zones/3/set/volume' -m '40'      # absolute
mosquitto_pub -t 'sonn/zones/3/set/volume' -m '+5'      # relative, like a remote
mosquitto_pub -t 'sonn/zones/3/set/state'  -m 'paused'
mosquitto_pub -t 'sonn/zones/3/set/next'   -m '1'       # value ignored

mosquitto_pub -t 'sonn/zones/3/cmd' -m '{"power":"on","volume":40}'
mosquitto_pub -t 'sonn/zones/3/cmd' -m '{"play":"applemusic:track:…"}'
```

Writable fields: `volume`, `state`, `power`, `position`, `repeat`, `shuffle`, `next`,
`previous`, `play`. The values are the ones the state topics publish — write `paused`, not
some separate command word — and booleans accept `1`/`true`/`on`/`yes` and their opposites.
A message carrying several fields is applied in a sensible order regardless of key order:
power before volume, so `{"power":"on","volume":40}` does what it looks like.

An invalid value is refused whole rather than applied in part, and an unknown field is
ignored, so echoing our own state topics back does no harm.

> **Publish commands unretained.** A retained command is replayed to us every time we
> reconnect, which makes a zone lurch back to it after each restart. The server refuses
> replayed commands and *deletes* the retained message, so the surprise happens once — but
> `mosquitto_pub -r` on a command topic is never what you want.

Access is your broker's business: anyone allowed to publish to these topics can control
the audio, exactly as anyone allowed to read the state topics can watch it. Use your
broker's own credentials and per-topic ACLs.

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
- **A device that reconnects is put back to playing by the server.** If a player drops off
  and returns while its zone was playing, the server starts its stream again by itself —
  the position restarts, the track and queue do not. You do not need to watch for this and
  you should not send a stop/play (or an off/on/play) to force it. Anything doing that
  today can drop it; if you still see a zone reporting `playing` with nothing audible after
  a device returns, that is a bug worth reporting rather than working around.
- **The version is in the path.** Within `v1`, fields are only ever added — nothing is
  renamed or removed under you. Anything that has to break appears as `v2`, served
  alongside `v1` rather than replacing it, so you migrate when it suits you. Calling
  `/api/...` without a version returns `404 api-version-required` and names the prefix
  to use, rather than failing in some way you have to guess at.

## Choosing the right surface

`/api` reads state, controls playback, and browses and searches the content this server can
reach. Where it stops is *playing content yourself*: it hands you ids to play through a
zone, not audio to decode. If you are building something that streams — an app with offline
sync, a phone client — a Subsonic app already does all of that and you would be rebuilding
it. See [Access](README.md#access) for how to enable each of these.

| Surface | Use it for |
| --- | --- |
| `/api` | Reading zone state, controlling playback, browsing and searching — start here |
| MQTT | The same state and transport controls, where a broker already exists. Nothing beyond that |
| Subsonic (`/rest/*`) | Browsing and streaming the library with existing apps |
| DLNA / UPnP | Renderers, and discovery by TVs and network speakers |
| WebDAV (`/dav`) | Adding and organising files in the library |
| Loxone (`7091`/`7095`) | The Loxone Miniserver and native app only — not a general API |
