import './env.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, normalizeHost } from './db.ts';
import { Router, type Match } from './router.ts';
import { LifecycleManager } from './lifecycle/manager.ts';
import * as pm2 from './lifecycle/pm2.ts';
import { proxyHttp, proxyUpgrade } from './proxy.ts';
import { serveStatic } from './static.ts';
import { wakePage } from './wakePage.ts';
import { JobRunner } from './jobs.ts';
import { MdnsPublisher } from './mdns.ts';
import { handleAdminApi, type Ctx } from './admin/api.ts';
import { UsageLog } from './usage.ts';
import { ReadyHub } from './lifecycle/ready.ts';
import { pm2Name } from './lifecycle/manager.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = resolve(process.env.LOCALSERVER_DATA ?? join(ROOT, 'data'));
const UI_DIST = join(ROOT, 'ui', 'dist');
/** How long a browser navigation waits for a cold backend before showing the wake page. */
const NAV_WAIT_MS = 1500;

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(join(DATA_DIR, 'localserver.db'));
if (process.env.PORT) store.updateSettings({ listenPort: Number(process.env.PORT) });
const router = new Router(store);
const readyHub = new ReadyHub(join(DATA_DIR, 'ready.sock'));
const lifecycle = new LifecycleManager(store, join(DATA_DIR, 'logs'), DATA_DIR, readyHub);
const usage = new UsageLog(join(DATA_DIR, 'usage'));
lifecycle.on('usage', (e) => usage.write(e));
const jobs = new JobRunner();
const mdns = new MdnsPublisher();

const ctx: Ctx = { store, router, lifecycle, jobs, mdns, reload };

// ---------------------------------------------------------------------------
// helpers

function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

function isAdminHost(host: string): boolean {
  return store.getSettings().adminHosts.includes(host) || (isIpLiteral(host) && !router.knowsHost(host));
}

function wantsHtml(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  if (req.headers['sec-fetch-mode'] === 'navigate') return true;
  return String(req.headers.accept ?? '').includes('text/html');
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function checkAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  const pw = store.getSettings().adminPassword;
  if (!pw) {
    sendText(res, 403, 'localserver admin is only available on this Mac. Set an admin password in Settings to allow LAN access.');
    return false;
  }
  const m = String(req.headers.authorization ?? '').match(/^Basic (.+)$/);
  const given = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(given);
  const b = Buffer.from(pw);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="localserver"' }).end();
  return false;
}

/**
 * The admin API can launch arbitrary commands, so block cross-site requests:
 * mutations need a custom header (forcing a CORS preflight we never approve) and a same-host Origin.
 */
function checkCsrf(req: IncomingMessage, host: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers['x-localserver'] !== '1') return false;
  const origin = req.headers.origin;
  return !origin || normalizeHost(origin) === host;
}

// ---------------------------------------------------------------------------
// request handling

function handleAdmin(req: IncomingMessage, res: ServerResponse, host: string): void {
  if (!checkAdminAuth(req, res)) return;
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];
  if (pathname.startsWith('/_api/')) {
    if (!checkCsrf(req, host)) return sendText(res, 403, 'cross-site request blocked');
    void handleAdminApi(ctx, req, res, pathname);
    return;
  }
  serveStatic(req, res, UI_DIST, url, true);
}

async function handleApp(req: IncomingMessage, res: ServerResponse, m: Match): Promise<void> {
  const { app, service: svc } = m;
  if (!isLoopback(req.socket.remoteAddress) && !svc.lanVisible) return sendText(res, 404, 'Not found');

  if (svc.kind === 'static') {
    serveStatic(req, res, resolve(svc.cwd || '/', svc.distDir || '.'), m.upstreamPath, svc.spaFallback);
    return;
  }

  lifecycle.begin(svc.id);
  const t0 = Date.now();
  const cold = lifecycle.rt(svc.id).state !== 'ready';
  let proxiedAt = 0;
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      lifecycle.end(svc.id);
      usage.write({
        ev: 'req', svc: pm2Name(app, svc), cold, waitMs: proxiedAt ? proxiedAt - t0 : null, ms: Date.now() - t0, status: res.statusCode,
        // requests from the traffic simulator are tagged so they can be told apart from real use
        ...(req.headers['x-ls-synthetic'] ? { synthetic: String(req.headers['x-ls-synthetic']) } : {}),
      });
    }
  };
  res.once('close', end);

  if (lifecycle.rt(svc.id).state !== 'ready') {
    const ready = lifecycle.ensureReady(svc.id);
    if (wantsHtml(req)) {
      // Give fast backends a chance to come up without flashing the wake page.
      const outcome = await Promise.race([
        ready.then(() => 'ready' as const, (e: Error) => e),
        new Promise<'wait'>((r) => setTimeout(() => r('wait'), NAV_WAIT_MS)),
      ]);
      if (outcome instanceof Error) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(wakePage(app.name, svc.name, outcome.message));
        return;
      }
      if (outcome === 'wait') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1' });
        res.end(wakePage(app.name, svc.name));
        return;
      }
    } else {
      try {
        await ready;
      } catch (e) {
        return sendText(res, 502, `localserver: ${app.name}/${svc.name} failed to start: ${(e as Error).message}`);
      }
    }
  }

  proxiedAt = Date.now();
  proxyHttp(req, res, { port: store.getService(svc.id)?.port ?? svc.port!, path: m.upstreamPath, preserveHost: svc.preserveHost }, {
    onRefused: () => lifecycle.markDown(svc.id),
    onDone: end,
  });
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  const host = normalizeHost(req.headers.host ?? '');
  const m = router.match(host, req.url ?? '/');
  if (m) {
    handleApp(req, res, m).catch((e) => {
      console.error('[gateway]', e);
      if (!res.headersSent) sendText(res, 500, 'localserver: internal error');
    });
    return;
  }
  if (isAdminHost(host)) return handleAdmin(req, res, host);
  sendText(
    res,
    404,
    `localserver: no app is configured for ${host}${req.url}\n` +
      (isLoopback(req.socket.remoteAddress) ? `Add one at http://localserver.localhost\n` : ''),
  );
}

async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  socket.on('error', () => {});
  const host = normalizeHost(req.headers.host ?? '');
  const m = router.match(host, req.url ?? '/');
  const svc = m?.service;
  if (!m || !svc || svc.kind !== 'process' || (!isLoopback(req.socket.remoteAddress) && !svc.lanVisible)) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  lifecycle.begin(svc.id);
  try {
    await lifecycle.ensureReady(svc.id);
  } catch {
    lifecycle.end(svc.id);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    return;
  }
  let opened = false;
  let openedAt = 0;
  proxyUpgrade(req, socket, head, { port: store.getService(svc.id)?.port ?? svc.port!, path: m.upstreamPath, preserveHost: svc.preserveHost }, {
    onOpen: () => {
      opened = true;
      openedAt = Date.now();
      // Logged at open too: an open socket keeps a service warm, and one may never close in a window.
      usage.write({ ev: 'ws_open', svc: pm2Name(m.app, svc), ...(req.headers['x-ls-synthetic'] ? { synthetic: String(req.headers['x-ls-synthetic']) } : {}) });
      lifecycle.end(svc.id);
      lifecycle.socketOpened(svc.id);
    },
    onRefused: () => lifecycle.markDown(svc.id),
    onDone: () => {
      if (opened) {
        lifecycle.socketClosed(svc.id);
        usage.write({ ev: 'ws', svc: pm2Name(m.app, svc), ms: Date.now() - openedAt });
      } else lifecycle.end(svc.id);
    },
  });
}

// ---------------------------------------------------------------------------
// listeners: loopback only, or all interfaces in LAN mode

let server: Server | null = null;
let boundPort = 0;

function makeServer(): Server {
  const s = createServer({ requestTimeout: 0, headersTimeout: 30_000 }, onRequest);
  s.on('upgrade', (req, socket, head) => void onUpgrade(req, socket, head));
  // Always bound on every interface; with LAN mode off, anything not from this Mac is dropped on connect.
  s.on('connection', (sock) => {
    if (!store.getSettings().lanEnabled && !isLoopback(sock.remoteAddress)) sock.destroy();
  });
  s.on('clientError', (_e, sock) => sock.writable && sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return s;
}

/** Binds one dual-stack socket. Only a port change rebinds, and the old socket is kept until the new one is up. */
async function applyListen(): Promise<void> {
  const { listenPort } = store.getSettings();
  if (listenPort === boundPort) return;
  const next = makeServer();
  await new Promise<void>((ok, fail) => {
    next.once('error', fail);
    next.listen({ port: listenPort, host: '::', ipv6Only: false }, () => ok());
  });
  const old = server;
  server = next;
  boundPort = listenPort;
  if (old) {
    old.close();
    old.closeAllConnections();
  }
  console.log(`[gateway] listening on *:${listenPort}`);
}

/**
 * Second listener used only as the target of the pf port-80 redirect (scripts/setup-pf.sh).
 * macOS pf breaks direct loopback connections to a port an rdr rule points at, so the redirect
 * gets its own port and the main port stays usable directly (http://….localhost:8080).
 */
const REDIRECT_PORT = Number(process.env.LOCALSERVER_REDIRECT_PORT ?? 8079);
let redirectServer: Server | null = null;

async function listenRedirect(): Promise<void> {
  const s = makeServer();
  await new Promise<void>((ok, fail) => {
    s.once('error', fail);
    s.listen({ port: REDIRECT_PORT, host: '::', ipv6Only: false }, () => ok());
  }).then(
    () => {
      redirectServer = s;
      console.log(`[gateway] port-80 redirect target on *:${REDIRECT_PORT}`);
    },
    (e: NodeJS.ErrnoException) => console.error(`[gateway] could not listen on redirect port ${REDIRECT_PORT} (${e.code ?? e.message})`),
  );
}

// ---------------------------------------------------------------------------
// single instance: a second gateway would fight over the port and publish duplicate .local names

const LOCK_FILE = join(DATA_DIR, 'gateway.pid');

function acquireLock(): void {
  try {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if that process is gone
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      if (cmd.includes('gateway/src/index.ts')) {
        console.error(`[gateway] another gateway is already running (pid ${pid}). Stop it first, or use: pm2 restart localserver`);
        process.exit(1);
      }
    }
  } catch {
    // no lock, stale lock, or unreadable: take it
  }
  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    if (Number(readFileSync(LOCK_FILE, 'utf8')) === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

function reload(): Promise<void> {
  router.reload();
  const s = store.getSettings();
  if (s.lanEnabled) {
    mdns.sync([...s.adminHosts, ...store.listApps().flatMap((a) => a.domains)], 80);
  } else {
    mdns.stop();
  }
  const p = applyListen();
  p.catch((e) => console.error(`[gateway] could not listen on :${s.listenPort} (${e.code ?? e.message}); still on :${boundPort || 'nothing'}`));
  return p;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  acquireLock();
  await readyHub.start();
  await pm2.connect();
  await lifecycle.boot();
  await reload();
  await listenRedirect();
  usage.startSampling(60_000, () => lifecycle.running());
  // Re-check the LAN IP periodically (Wi-Fi changes) so .local names stay correct.
  setInterval(() => store.getSettings().lanEnabled && void reload(), 30_000).unref();
}

function shutdown(): void {
  console.log('[gateway] shutting down (managed apps keep running and are re-adopted on restart)');
  lifecycle.shutdown();
  mdns.stop();
  server?.close();
  redirectServer?.close();
  usage.close();
  readyHub.close();
  releaseLock();
  pm2.disconnect();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('[gateway] fatal', e);
  process.exit(1);
});
