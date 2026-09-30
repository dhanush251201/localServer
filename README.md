# localserver

One gateway for all your local sites. Each request is routed by **domain and path**. A backend is **started on the first request** and **stopped after it has been idle for a while**. Frontends are served as static `dist/` folders or run as dev servers. Everything is managed from a web dashboard.

```
browser ──:80──pf──▶ :8080  gateway (pm2 process "localserver")
                     ├─ localserver.localhost      → dashboard + /_api
                     ├─ time.localhost/            → static  time/dist
                     └─ time.localhost/api         → process ls-time-backend (pm2, started on demand)
```

## Quick start

```bash
npm install
npm run pm2:start        # builds the dashboard, starts the gateway under pm2
```

Open **http://localserver.localhost:8080**. Chrome and Firefox send any `*.localhost` name to 127.0.0.1, so you don't need `/etc/hosts` entries.

URLs without a port, including from your phone (one-time, needs sudo):

```bash
sudo ./scripts/setup-pf.sh          # forwards :80 → :8080, survives reboots
sudo ./scripts/teardown-pf.sh       # undo
```

To start the gateway at login: `pm2 save && pm2 startup` (then run the command it prints).

## Concepts

| Thing | What it is |
|---|---|
| **App** | A site with one or more domains (`time.localhost`, `time.local`). |
| **Service** | Either **static** (serve a folder, with optional SPA fallback) or a **process** (anything pm2 can run: `server.js`, `npm run dev`, `python3 app.py`). |
| **Route** | `host? + path prefix → service`. An explicit host beats "any of the app's domains", then the longest prefix wins. Options: strip prefix. |

Process services:

- **Port.** Leave it blank to auto-assign one from 7000–7999. The port is always passed as `$PORT`, and `{port}` in the arguments or env is replaced with it. Use this for dev servers that ignore `$PORT`, e.g. `npm run dev -- --port {port} --strictPort`.
- **Idle timeout.** Uses the global default (10 min), a custom time, or never (always on). A service with an open WebSocket/SSE connection is never considered idle.
- **Readiness.** The gateway waits for the port to accept connections, or for `healthPath` to answer with a status below 500. Browser page loads wait up to 1.5s, then get a "Starting…" page that reloads itself. API calls just wait.
- **Host header.** By default it is rewritten to `localhost:<port>`, which is what vite's `allowedHosts` check expects. The original is sent as `X-Forwarded-Host`.
- **pm2 names.** Processes run as `ls-<app>-<service>` in the pm2 namespace `localserver`, with logs in `data/logs/`. Restarting the gateway leaves them running and re-adopts them.

## Migrating an existing pm2 app

Use **Import from pm2** in the dashboard. Choose the processes that make up one site and set the mount path for each (`/`, `/api`). By default the originals are stopped, not deleted. When you're happy with the result, run `pm2 delete <old-name> && pm2 save`.

Things to check afterwards:

- **Frontend API base URL.** A frontend that calls `http://localhost:4000` directly bypasses the gateway, and that backend never wakes up. Make the calls relative instead (e.g. build with `VITE_API_BASE_URL=`), so `/api/...` goes through the same domain.
- **Frontend as static or dev server.** A static frontend (Service → Static files, folder `dist`, build command `npm run build`) starts instantly and has a Build button. A vite dev server gives you HMR but takes 1–3 s to cold-start.
- **Scheduled jobs** (e.g. `job-tracker-backup`) should stay in plain pm2, because nothing sends them requests.

## LAN / phone access

Settings → **LAN mode**. With it on:

- the gateway accepts connections on all interfaces;
- every single-label `*.local` domain (`time.local`, not `api.time.local`) is published over Bonjour through `dns-sd`, so iPhones and modern Android phones resolve it with no DNS setup;
- the dashboard requires the admin password for non-loopback clients (without one, it's only available on this Mac);
- a service with "Reachable from other devices" turned off returns 404 to other devices.

On the LAN, use path routes (`time.local/api`) rather than subdomains.

## Development

```bash
LOCALSERVER_DATA=/tmp/ls PORT=8090 npm start    # gateway with a scratch database
npm run dev:ui                                  # dashboard with HMR on :5190 (proxies /_api to :8080)
npm run typecheck
```

Layout: `gateway/src` (Node 25 runs the TypeScript directly, with no build step), `ui/src` (React + Vite), `scripts/` (pf setup). State lives in `data/localserver.db` (SQLite).

## Security notes

The admin API can launch arbitrary commands, so:

- it answers only on the admin hosts;
- non-loopback clients need the password;
- mutating requests must carry an `X-Localserver: 1` header and a same-host `Origin`, so other websites you visit can't drive it.

App traffic is plain HTTP.
