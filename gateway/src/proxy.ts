import { Agent, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';

const agent = new Agent({ keepAlive: true, maxSockets: 256 });

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

export interface Target {
  port: number;
  path: string;
  preserveHost: boolean;
}

export interface Hooks {
  /** Upstream refused the connection: it probably died. */
  onRefused(): void;
  onDone(): void;
}

/** True when the Origin header names the same host:port the request was sent to. */
function isSameSite(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function forwardHeaders(req: IncomingMessage, t: Target, keepUpgrade = false): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  const connTokens = String(req.headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim());
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k) || connTokens.includes(k)) continue;
    out[k] = v;
  }
  const origHost = req.headers.host ?? '';
  const remote = req.socket.remoteAddress ?? '';
  out['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${remote}` : remote;
  out['x-forwarded-host'] = origHost;
  out['x-forwarded-proto'] = 'http';
  out['x-real-ip'] = remote;
  if (!t.preserveHost) {
    // Dev servers (vite) and local-only apps reject unknown Host headers; present ourselves as a local client.
    out.host = `localhost:${t.port}`;
    // Rewrite Origin to match, but only for same-site requests (Origin == the domain the browser is on).
    // A foreign Origin is passed through untouched so the app's own cross-site checks still reject it.
    if (typeof out.origin === 'string' && isSameSite(out.origin, origHost)) out.origin = `http://localhost:${t.port}`;
  }
  if (keepUpgrade) {
    out.connection = 'Upgrade';
    out.upgrade = req.headers.upgrade;
  }
  return out;
}

/** Turn absolute redirects to localhost:<port> back into relative ones so the browser stays on the gateway domain. */
function rewriteLocation(loc: string, port: number): string {
  const m = loc.match(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i);
  return m && Number(m[2]) === port ? m[3] || '/' : loc;
}

export function proxyHttp(req: IncomingMessage, res: ServerResponse, t: Target, hooks: Hooks): void {
  let finished = false;
  const done = () => {
    if (!finished) {
      finished = true;
      hooks.onDone();
    }
  };
  res.once('close', done);

  const upstream = request(
    {
      host: 'localhost',
      port: t.port,
      method: req.method,
      path: t.path,
      headers: forwardHeaders(req, t),
      agent,
    },
    (up) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k)) continue;
        headers[k] = k === 'location' && typeof v === 'string' ? rewriteLocation(v, t.port) : v;
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
      up.pipe(res);
      up.once('error', () => res.destroy());
    },
  );

  upstream.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNREFUSED') hooks.onRefused();
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`localserver: upstream on port ${t.port} failed (${err.code ?? err.message})`);
    } else {
      res.destroy();
    }
  });
  // Browser went away: stop talking to upstream (important for SSE / long polls).
  res.once('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function writeHead(socket: Duplex, status: number, message: string, rawHeaders: string[]): void {
  let head = `HTTP/1.1 ${status} ${message}\r\n`;
  for (let i = 0; i < rawHeaders.length; i += 2) head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  socket.write(head + '\r\n');
}

/** WebSocket (or any HTTP Upgrade) tunnelling. hooks.onDone fires when the tunnel closes. */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, t: Target, hooks: Hooks & { onOpen(): void }): void {
  (socket as Socket).setTimeout?.(0);
  const upstream = request({
    host: 'localhost',
    port: t.port,
    method: req.method,
    path: t.path,
    headers: forwardHeaders(req, t, true),
  });

  upstream.once('upgrade', (up, upSocket, upHead) => {
    writeHead(socket, up.statusCode ?? 101, up.statusMessage ?? 'Switching Protocols', up.rawHeaders);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    hooks.onOpen();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      upSocket.destroy();
      hooks.onDone();
    };
    // Server sockets are half-open by default, so treat either side ending as the end of the tunnel.
    for (const s of [socket, upSocket]) s.once('close', close).once('error', close).once('end', close);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });

  // Upstream answered with a normal response (e.g. 400/426): relay it and close.
  upstream.once('response', (up) => {
    writeHead(socket, up.statusCode ?? 502, up.statusMessage ?? '', up.rawHeaders);
    up.pipe(socket);
    up.once('end', () => socket.end());
    hooks.onDone();
  });

  upstream.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNREFUSED') hooks.onRefused();
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    hooks.onDone();
  });
  upstream.end();
}
