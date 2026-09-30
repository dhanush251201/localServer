import type { IncomingMessage, ServerResponse } from 'node:http';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError, normalizeHost, type Store } from '../db.ts';
import type { Router } from '../router.ts';
import type { LifecycleManager } from '../lifecycle/manager.ts';
import { pm2Name, tailFile } from '../lifecycle/manager.ts';
import * as pm2 from '../lifecycle/pm2.ts';
import type { JobRunner } from '../jobs.ts';
import { lanAddress, type MdnsPublisher } from '../mdns.ts';
import type { App, Route, Service, Settings } from '../types.ts';

export interface Ctx {
  store: Store;
  router: Router;
  lifecycle: LifecycleManager;
  jobs: JobRunner;
  mdns: MdnsPublisher;
  /** Re-read config into router + mDNS after a change. */
  reload(): Promise<void>;
}

/** Fields that require a restart of a running process when changed. */
const RESTART_FIELDS: (keyof Service)[] = ['cwd', 'command', 'args', 'env', 'interpreter', 'port', 'slug'];

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function publicSettings(s: Settings) {
  const { adminPassword, ...rest } = s;
  return { ...rest, adminPasswordSet: Boolean(adminPassword) };
}

export function buildState(ctx: Ctx) {
  const { store, lifecycle } = ctx;
  const settings = store.getSettings();
  const now = Date.now();
  return {
    now,
    settings: publicSettings(settings),
    lanIp: lanAddress(),
    mdns: ctx.mdns.published(),
    apps: store.listApps().map((app) => ({
      ...app,
      routes: store.listRoutes(app.id),
      services: store.listServices(app.id).map((svc) => {
        const rt = lifecycle.rt(svc.id);
        const idle = lifecycle.idleTimeoutSec(svc);
        return {
          ...svc,
          pm2Name: svc.kind === 'process' ? pm2Name(app, svc) : null,
          effectiveIdleTimeoutSec: idle,
          runtime: {
            ...rt,
            idleStopAt:
              svc.kind === 'process' && rt.state === 'ready' && idle > 0 && rt.inflight === 0 && rt.sockets === 0
                ? rt.lastActivity + idle * 1000
                : null,
          },
          build: ctx.jobs.latest(svc.id) ? { ...ctx.jobs.latest(svc.id)!, output: undefined } : null,
        };
      }),
    })),
  };
}

type Handler = (ctx: Ctx, req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), h]);

function appOr404(ctx: Ctx, id: string): App {
  const a = ctx.store.getApp(Number(id));
  if (!a) throw new HttpError(404, 'app not found');
  return a;
}

function serviceOr404(ctx: Ctx, id: string): { app: App; svc: Service } {
  const svc = ctx.store.getService(Number(id));
  const app = svc && ctx.store.getApp(svc.appId);
  if (!svc || !app) throw new HttpError(404, 'service not found');
  return { app, svc };
}

function validateService(input: Partial<Service>): void {
  if (input.kind && input.kind !== 'static' && input.kind !== 'process') throw new HttpError(400, 'kind must be static or process');
  if (input.port != null && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new HttpError(400, 'invalid port');
  if (input.args && !Array.isArray(input.args)) throw new HttpError(400, 'args must be an array');
  if (input.env && (typeof input.env !== 'object' || Array.isArray(input.env))) throw new HttpError(400, 'env must be an object');
}

function assertUniqueDomains(ctx: Ctx, domains: string[], selfId?: number): void {
  const adminHosts = new Set(ctx.store.getSettings().adminHosts);
  for (const d of domains.map(normalizeHost)) {
    if (adminHosts.has(d)) throw new HttpError(409, `${d} is reserved for the admin UI`);
    const owner = ctx.store.listApps().find((a) => a.id !== selfId && a.domains.includes(d));
    if (owner) throw new HttpError(409, `${d} is already used by ${owner.name}`);
  }
}

// ---- state ----

on('GET', '/_api/state', (ctx, _req, res) => json(res, 200, buildState(ctx)));

on('GET', '/_api/events', (ctx, req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`event: state\ndata: ${JSON.stringify(buildState(ctx))}\n\n`);
  let queued: NodeJS.Timeout | null = null;
  const push = () => {
    queued ??= setTimeout(() => {
      queued = null;
      res.write(`event: state\ndata: ${JSON.stringify(buildState(ctx))}\n\n`);
    }, 150);
  };
  const onJob = (job: { serviceId: number }, chunk: string) =>
    res.write(`event: build\ndata: ${JSON.stringify({ serviceId: job.serviceId, chunk })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  ctx.lifecycle.on('change', push);
  ctx.jobs.on('output', onJob);
  ctx.jobs.on('done', push);
  ctx.jobs.on('start', push);
  // Periodic refresh so memory/cpu and idle countdowns stay current.
  const tick = setInterval(push, 5_000);
  req.once('close', () => {
    clearInterval(ping);
    clearInterval(tick);
    if (queued) clearTimeout(queued);
    ctx.lifecycle.off('change', push);
    ctx.jobs.off('output', onJob);
    ctx.jobs.off('done', push);
    ctx.jobs.off('start', push);
  });
});

// ---- settings ----

on('PATCH', '/_api/settings', async (ctx, req, res) => {
  const body = await readJson(req);
  const patch: Partial<Settings> = {};
  if ('readiness' in body) {
    if (body.readiness !== 'notify' && body.readiness !== 'poll') throw new HttpError(400, 'readiness must be notify or poll');
    patch.readiness = body.readiness;
  }
  if ('compileCache' in body) patch.compileCache = Boolean(body.compileCache);
  if ('pm2Instrumentation' in body) patch.pm2Instrumentation = Boolean(body.pm2Instrumentation);
  if ('fastControlPath' in body) patch.fastControlPath = Boolean(body.fastControlPath);
  for (const k of ['listenPort', 'defaultIdleTimeoutSec', 'portRangeStart', 'portRangeEnd', 'pollIntervalMs'] as const) {
    if (k in body) {
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < 0 || n > 65535 * 1000) throw new HttpError(400, `invalid ${k}`);
      patch[k] = n;
    }
  }
  if ('lanEnabled' in body) patch.lanEnabled = Boolean(body.lanEnabled);
  if (typeof body.adminPassword === 'string') patch.adminPassword = body.adminPassword;
  if (Array.isArray(body.adminHosts)) patch.adminHosts = body.adminHosts.map(String).map(normalizeHost).filter(Boolean);
  ctx.store.updateSettings(patch);
  ctx.reload();
  json(res, 200, publicSettings(ctx.store.getSettings()));
});

// ---- apps ----

/**
 * Body: { name, slug?, domains?, services?: [{ ...service, route?: { pathPrefix, host, stripPrefix } }] }
 * Creating with services lets the UI (and pm2 import) set up a whole app in one call.
 */
on('POST', '/_api/apps', async (ctx, req, res) => {
  const body = await readJson(req);
  if (!body.name || typeof body.name !== 'string') throw new HttpError(400, 'name is required');
  const services: any[] = Array.isArray(body.services) ? body.services : [];
  services.forEach(validateService);
  const { store } = ctx;
  store.db.exec('BEGIN');
  try {
    const app = store.createApp(body);
    assertUniqueDomains(ctx, app.domains, app.id);
    for (const s of services) {
      const { route, ...svcInput } = s;
      const svc = store.createService(app.id, svcInput);
      if (route !== false) store.createRoute(app.id, { serviceId: svc.id, pathPrefix: '/', ...(route ?? {}) });
    }
    store.db.exec('COMMIT');
    ctx.reload();
    json(res, 201, app);
  } catch (e) {
    store.db.exec('ROLLBACK');
    if (/UNIQUE constraint failed: apps.slug/.test(String(e))) throw new HttpError(409, 'an app with that slug already exists');
    throw e;
  }
});

on('PATCH', '/_api/apps/:id', async (ctx, req, res, [id]) => {
  const cur = appOr404(ctx, id);
  const body = await readJson(req);
  if (body.domains) assertUniqueDomains(ctx, body.domains, cur.id);
  const next = ctx.store.updateApp(cur.id, body);
  if (next.slug !== cur.slug) {
    // pm2 names derive from the slug; drop the old processes.
    for (const svc of ctx.store.listServices(cur.id)) await ctx.lifecycle.forget(cur, svc);
  }
  ctx.reload();
  json(res, 200, next);
});

on('DELETE', '/_api/apps/:id', async (ctx, _req, res, [id]) => {
  const app = appOr404(ctx, id);
  for (const svc of ctx.store.listServices(app.id)) await ctx.lifecycle.forget(app, svc);
  ctx.store.deleteApp(app.id);
  ctx.reload();
  json(res, 200, { ok: true });
});

// ---- services ----

on('POST', '/_api/apps/:id/services', async (ctx, req, res, [id]) => {
  const app = appOr404(ctx, id);
  const body = await readJson(req);
  if (!body.name || !body.kind) throw new HttpError(400, 'name and kind are required');
  validateService(body);
  const { route, ...svcInput } = body;
  const svc = ctx.store.createService(app.id, svcInput);
  if (route) ctx.store.createRoute(app.id, { serviceId: svc.id, pathPrefix: '/', ...route });
  ctx.reload();
  json(res, 201, svc);
});

on('PATCH', '/_api/services/:id', async (ctx, req, res, [id]) => {
  const { app, svc } = serviceOr404(ctx, id);
  const body = await readJson(req);
  validateService(body);
  const next = ctx.store.updateService(svc.id, body);
  const needsRestart = RESTART_FIELDS.some((k) => JSON.stringify(svc[k]) !== JSON.stringify(next[k]));
  const wasRunning = ctx.lifecycle.rt(svc.id).state === 'ready';
  if (needsRestart && svc.kind === 'process') {
    if (svc.slug !== next.slug) await ctx.lifecycle.forget(app, svc);
    else if (wasRunning) await ctx.lifecycle.stop(svc.id, 'config changed');
    if (wasRunning && next.kind === 'process') ctx.lifecycle.ensureReady(next.id).catch(() => {});
  }
  if (next.kind === 'static') ctx.lifecycle.rt(next.id).state = 'ready';
  ctx.reload();
  json(res, 200, next);
});

on('DELETE', '/_api/services/:id', async (ctx, _req, res, [id]) => {
  const { app, svc } = serviceOr404(ctx, id);
  await ctx.lifecycle.forget(app, svc);
  ctx.store.deleteService(svc.id);
  ctx.reload();
  json(res, 200, { ok: true });
});

on('POST', '/_api/services/:id/start', async (ctx, _req, res, [id]) => {
  const { svc } = serviceOr404(ctx, id);
  try {
    await ctx.lifecycle.ensureReady(svc.id);
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

on('POST', '/_api/services/:id/stop', async (ctx, _req, res, [id]) => {
  const { svc } = serviceOr404(ctx, id);
  await ctx.lifecycle.stop(svc.id);
  json(res, 200, { ok: true });
});

on('POST', '/_api/services/:id/restart', async (ctx, _req, res, [id]) => {
  const { svc } = serviceOr404(ctx, id);
  try {
    await ctx.lifecycle.restart(svc.id);
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

on('POST', '/_api/services/:id/build', (ctx, _req, res, [id]) => {
  const { svc } = serviceOr404(ctx, id);
  if (!svc.buildCommand) throw new HttpError(400, 'no build command configured');
  const job = ctx.jobs.run(svc.id, svc.buildCommand, resolve(svc.cwd || '.'), svc.env);
  json(res, 202, { ...job, output: undefined });
});

on('GET', '/_api/services/:id/build', (ctx, _req, res, [id]) => {
  const { svc } = serviceOr404(ctx, id);
  json(res, 200, ctx.jobs.latest(svc.id) ?? null);
});

/** SSE tail of the service's pm2 logs: sends the last ~16KB, then appends as the files grow. */
on('GET', '/_api/services/:id/logs', (ctx, req, res, [id]) => {
  const { app, svc } = serviceOr404(ctx, id);
  const files = ctx.lifecycle.logPaths(app, svc);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (stream: string, text: string) => text && res.write(`data: ${JSON.stringify({ stream, text })}\n\n`);
  const offsets: Record<string, number> = {};
  for (const [stream, file] of Object.entries(files)) {
    send(stream, tailFile(file, 16_384));
    try {
      offsets[stream] = statSync(file).size;
    } catch {
      offsets[stream] = 0;
    }
  }
  const poll = setInterval(() => {
    for (const [stream, file] of Object.entries(files)) {
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size < offsets[stream]) offsets[stream] = 0; // truncated / rotated
      if (size === offsets[stream]) continue;
      const len = Math.min(size - offsets[stream], 256_000);
      const buf = Buffer.alloc(len);
      const fd = openSync(file, 'r');
      readSync(fd, buf, 0, len, offsets[stream]);
      closeSync(fd);
      offsets[stream] += len;
      send(stream, buf.toString('utf8'));
    }
  }, 1000);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.once('close', () => {
    clearInterval(poll);
    clearInterval(ping);
  });
});

// ---- routes ----

on('POST', '/_api/apps/:id/routes', async (ctx, req, res, [id]) => {
  const app = appOr404(ctx, id);
  const body = await readJson(req);
  const r = ctx.store.createRoute(app.id, { ...body, serviceId: Number(body.serviceId) });
  ctx.reload();
  json(res, 201, r);
});

on('PATCH', '/_api/routes/:id', async (ctx, req, res, [id]) => {
  const body: Partial<Route> = await readJson(req);
  const r = ctx.store.updateRoute(Number(id), body);
  ctx.reload();
  json(res, 200, r);
});

on('DELETE', '/_api/routes/:id', (ctx, _req, res, [id]) => {
  ctx.store.deleteRoute(Number(id));
  ctx.reload();
  json(res, 200, { ok: true });
});

// ---- pm2 import ----

/** pm2 processes not managed by localserver, shaped as service drafts for the UI. */
on('GET', '/_api/pm2', async (_ctx, _req, res) => {
  const procs = await pm2.list();
  json(
    res,
    200,
    procs
      .filter((p) => p.namespace !== pm2.PM2_NAMESPACE && !p.name.startsWith('ls-') && p.name !== 'localserver')
      .map((p) => ({
        name: p.name,
        status: p.status,
        namespace: p.namespace,
        cwd: p.cwd,
        script: p.script,
        args: p.args,
        interpreter: p.interpreter,
        port: p.env.PORT ? Number(p.env.PORT) || null : null,
        memory: p.memory,
        cron: p.cron,
      })),
  );
});

/** Stop (not delete) an original pm2 process after importing it, so its port is freed. */
on('POST', '/_api/pm2/stop', async (_ctx, req, res) => {
  const { name } = await readJson(req);
  const p = typeof name === 'string' ? await pm2.describe(name) : null;
  if (!p) throw new HttpError(404, 'pm2 process not found');
  if (p.namespace === pm2.PM2_NAMESPACE || p.name.startsWith('ls-') || p.name === 'localserver') {
    throw new HttpError(400, 'that process is managed by localserver');
  }
  await pm2.stop(name);
  json(res, 200, { ok: true });
});

export async function handleAdminApi(ctx: Ctx, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  try {
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = pathname.match(re);
      if (m) return await h(ctx, req, res, m.slice(1));
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('[admin]', e);
    if (!res.headersSent) json(res, status, { error: (e as Error).message });
    else res.end();
  }
}
