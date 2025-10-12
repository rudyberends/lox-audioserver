# Loxone AudioServer add-on

This add-on packages [Lox-AudioServer](https://github.com/rudyberends/lox-audioserver) implementation so it can run under the Home Assistant Supervisor.

## Configuration

The add-on does not expose options in Supervisor. Configure the Miniserver credentials, AudioServer IP and provider settings through the built-in admin UI after the first start.

The admin UI is available at `http://<home-assistant-host>:7091/admin`. Use the Loxone Config workflow to pair the Miniserver with the AudioServer instance exposed by the add-on.

## Persistence

The add-on stores its configuration, caches and logs in the add-on data directory at `/data`. This data survives container upgrades and restarts.

## Updating

On start, the add-on will update persisted credentials and logging levels based on the configured options. Other settings should be adjusted via the admin UI.

## Ports

- `7091/tcp` – Admin UI and HTTP API
- `7095/tcp` – Loxone Miniserver pairing port
