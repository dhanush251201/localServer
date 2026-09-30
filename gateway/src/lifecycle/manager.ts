import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { Store } from '../db.ts';
import type { App, Service, ServiceState } from '../types.ts';
import { allocatePort, isPortFree } from '../ports.ts';
import * as pm2 from './pm2.ts';
import type { ReadyHub } from './ready.ts';

const READY_PROBE = fileURLToPath(new URL('./ready-probe.cjs', import.meta.url));

const REAP_INTERVAL_MS = 5_000;
const ERROR_BACKOFF_MS = 5_000;
/** Env passed through from the gateway so tools like npm/node/python resolve normally. */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

export interface Runtime {
  state: ServiceState;
  error: string;
  errorAt: number;
  lastActivity: number;
  inflight: number;
  sockets: number;
  startedAt: number;
  lastStartMs: number;
  memory: number;
  cpu: number;
  restarts: number;
  pid: number;
}

export function pm2Name(app: App, svc: Service): string {
  return `ls-${app.slug}-${svc.slug}`;
}

/** Processes the gateway started: in our namespace and named ls-*. */
export function isManagedName(p: { name: string; namespace: string }): boolean {
  return p.namespace === pm2.PM2_NAMESPACE && p.name.startsWith('ls-');
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = netConnect({ host: 'localhost', port, autoSelectFamily: true });
    sock.setTimeout(1000);
    sock.once('connect', () => {
      sock.destroy();
      done(true);
    });
    sock.once('error', () => done(false));
    sock.once('timeout', () => {
      sock.destroy();
      done(false);
    });
  });
}

function probeHttp(port: number, path: string): Promise<boolean> {
  return new Promise((done) => {
    const req = httpRequest({ host: 'localhost', port, path, method: 'GET', timeout: 2000 }, (res) => {
      res.resume();
      done((res.statusCode ?? 500) < 500);
    });
    req.once('error', () => done(false));
    req.once('timeout', () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

function which(cmd: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    const p = join(dir, cmd);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export function tailFile(file: string, bytes = 8192): string {
  try {
    const buf = readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
  } catch {
    return '';
  }
}

export class LifecycleManager extends EventEmitter {
  private store: Store;
  private logDir: string;
  private dataDir: string;
  private readyHub: ReadyHub | null;
  private runtimes = new Map<number, Runtime>();
  private pending = new Map<number, Promise<void>>();
  /** pm2's process list as of the last sync (every few seconds), by name. */
  private procCache = new Map<string, pm2.Pm2Proc>();
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, logDir: string, dataDir: string, readyHub: ReadyHub | null = null) {
    super();
    this.store = store;
    this.logDir = logDir;
    this.dataDir = dataDir;
    this.readyHub = readyHub;
  }

  rt(id: number): Runtime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = { state: 'stopped', error: '', errorAt: 0, lastActivity: 0, inflight: 0, sockets: 0, startedAt: 0, lastStartMs: 0, memory: 0, cpu: 0, restarts: 0, pid: 0 };
      this.runtimes.set(id, r);
    }
    return r;
  }

  private set(id: number, patch: Partial<Runtime>): void {
    Object.assign(this.rt(id), patch);
    this.emit('change', id);
  }

  idleTimeoutSec(svc: Service): number {
    return svc.idleTimeoutSec < 0 ? this.store.getSettings().defaultIdleTimeoutSec : svc.idleTimeoutSec;
  }

  logPaths(app: App, svc: Service): { out: string; err: string } {
    const name = pm2Name(app, svc);
    return { out: join(this.logDir, `${name}-out.log`), err: join(this.logDir, `${name}-err.log`) };
  }

  // ---- activity accounting (called by the proxy) ----

  begin(id: number): void {
    const r = this.rt(id);
    r.inflight++;
    r.lastActivity = Date.now();
  }

  end(id: number): void {
    const r = this.rt(id);
    r.inflight = Math.max(0, r.inflight - 1);
    r.lastActivity = Date.now();
  }

  socketOpened(id: number): void {
    const r = this.rt(id);
    r.sockets++;
    r.lastActivity = Date.now();
    this.emit('change', id);
  }

  socketClosed(id: number): void {
    const r = this.rt(id);
    r.sockets = Math.max(0, r.sockets - 1);
    r.lastActivity = Date.now();
    this.emit('change', id);
  }

  // ---- start / stop ----

  /** Resolves once the service accepts connections. Concurrent callers share one start. */
  ensureReady(svcId: number): Promise<void> {
    const r = this.rt(svcId);
    if (r.state === 'ready') return Promise.resolve();
    // A crash-looping backend shouldn't be relaunched by every incoming request.
    if (r.state === 'error' && Date.now() - r.errorAt < ERROR_BACKOFF_MS && !this.pending.has(svcId)) {
      return Promise.reject(new Error(r.error));
    }
    let p = this.pending.get(svcId);
    if (!p) {
      p = this.doStart(svcId).finally(() => this.pending.delete(svcId));
      this.pending.set(svcId, p);
    }
    return p;
  }

  private async doStart(svcId: number): Promise<void> {
    // Let an in-progress stop finish before starting again.
    while (this.rt(svcId).state === 'stopping') await new Promise((r) => setTimeout(r, 100));

    let svc = this.store.getService(svcId);
    const app = svc && this.store.getApp(svc.appId);
    if (!svc || !app) throw new Error('service not found');
    if (svc.kind !== 'process') {
      this.set(svcId, { state: 'ready' });
      return;
    }
    if (!svc.command) throw this.fail(svcId, 'no command configured');

    const t0 = Date.now();
    this.set(svcId, { state: 'starting', error: '' });

    try {
      if (svc.port == null) {
        const s = this.store.getSettings();
        const taken = new Set(this.store.listServices().map((x) => x.port).filter((x): x is number => x != null));
        taken.add(s.listenPort);
        svc = this.store.updateService(svc.id, { port: await allocatePort(s.portRangeStart, s.portRangeEnd, taken) });
      }
      const port = svc.port!;
      const name = pm2Name(app, svc);

      const tp = performance.now();
      const phases: Record<string, number> = {};
      let pm2Parts: Record<string, number> = {};
      const mark = (k: string) => {
        const n = performance.now();
        phases[k] = +(n - tp - Object.values(phases).reduce((a, b) => a + b, 0)).toFixed(2);
      };
      const fast = this.store.getSettings().fastControlPath;
      const cached = this.procCache.get(name);
      // Fast path: a describe round trip is only needed if the cached list says it might be running.
      const existing = !fast || !cached || cached.status === 'online' ? await pm2.describe(name).catch(() => null) : cached;
      mark('describe');
      if (existing?.status === 'online' && (await probeTcp(port))) {
        // Already running (e.g. after a gateway restart); adopt it.
        this.set(svcId, { state: 'ready', startedAt: existing.uptime, lastActivity: Date.now(), lastStartMs: 0 });
        this.emit('usage', { ev: 'adopt', svc: name });
        return;
      }
      if (!(await isPortFree(port))) {
        throw new Error(`port ${port} is already in use by another program; stop it or change this service's port`);
      }
      mark('portCheck');

      const spec = this.buildSpec(app, svc, port);
      // Register for the listen notification before starting, so it can't be missed.
      const notified = this.store.getSettings().readiness === 'notify' && this.readyHub ? this.readyHub.wait(name) : null;
      try {
        // Fast path: an unchanged, stopped definition is restarted in place rather than re-created.
        const reuse = fast && existing?.status === 'stopped' && existing.env.LS_SPEC_HASH === spec.env.LS_SPEC_HASH;
        let pt = reuse ? await pm2.startExisting(existing!.pmId).catch(() => null) : null;
        // Not reusable, or the cached process vanished (e.g. re-created since the last sync): full path.
        pt ??= await pm2.start(spec);
        if (!reuse) this.procCache.delete(name); // its pm_id changed; the next start re-reads it
        mark('pm2');
        pm2Parts = { pm2Remove: +pt.removeMs.toFixed(2), pm2Start: +pt.startMs.toFixed(2) };
        await this.waitReady(svc, name, port, t0 + svc.startTimeoutSec * 1000, notified?.promise);
        mark('ready');
      } finally {
        notified?.cancel();
      }

      this.set(svcId, { state: 'ready', startedAt: Date.now(), lastActivity: Date.now(), lastStartMs: Date.now() - t0 });
      console.log(`[lifecycle] ${name} ready on :${port} in ${Date.now() - t0}ms`);
      this.emit('usage', { ev: 'start', svc: name, ms: Date.now() - t0, phases: { ...phases, ...pm2Parts } });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[lifecycle] start failed for service ${svcId}: ${msg}`);
      this.emit('usage', { ev: 'start_failed', svc: pm2Name(app, svc), ms: Date.now() - t0 });
      // Don't leave a crash-looping process behind.
      await pm2.stop(pm2Name(app, svc)).catch(() => {});
      throw this.fail(svcId, msg);
    }
  }

  private fail(svcId: number, msg: string): Error {
    this.set(svcId, { state: 'error', error: msg, errorAt: Date.now() });
    return new Error(msg);
  }

  buildSpec(app: App, svc: Service, port: number): pm2.StartSpec {
    const cwd = resolve(svc.cwd || '.');
    const env: Record<string, string> = {};
    for (const k of PASSTHROUGH_ENV) if (process.env[k]) env[k] = process.env[k]!;
    Object.assign(env, svc.env, { PORT: String(port) });
    for (const [k, v] of Object.entries(env)) env[k] = v.replaceAll('{port}', String(port));
    const settings = this.store.getSettings();
    const name = pm2Name(app, svc);
    if (settings.readiness === 'notify' && this.readyHub) {
      // NODE_OPTIONS reaches every Node process the service starts (npm → vite), unlike node_args.
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(READY_PROBE)}`.trim();
      Object.assign(env, { LOCALSERVER_READY_SOCK: this.readyHub.path, LOCALSERVER_READY_PORT: String(port), LOCALSERVER_READY_NAME: name });
    }
    if (settings.compileCache && !env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = join(this.dataDir, 'compile-cache', name);

    let script = svc.command;
    if (!isAbsolute(script)) {
      const local = join(cwd, script);
      script = existsSync(local) ? local : (which(script, env.PATH ?? '') ?? script);
    }
    let interpreter = svc.interpreter || 'auto';
    // Scripts pm2 knows how to run keep "auto"; binaries (npm, python, uvicorn…) are exec'd directly.
    if (interpreter === 'auto' && !/\.(c|m)?(j|t)s$/.test(script)) interpreter = 'none';

    const logs = this.logPaths(app, svc);
    const specNoHash = { script, args: svc.args.map((a) => a.replaceAll('{port}', String(port))), cwd, env, interpreter, instr: settings.pm2Instrumentation };
    env.LS_SPEC_HASH = createHash('sha1').update(JSON.stringify(specNoHash)).digest('hex').slice(0, 16);
    return {
      name: pm2Name(app, svc),
      script,
      args: svc.args.map((a) => a.replaceAll('{port}', String(port))),
      cwd,
      env,
      interpreter,
      outLog: logs.out,
      errLog: logs.err,
      instrumentation: settings.pm2Instrumentation,
    };
  }

  /**
   * Ready when the app reports listen() (notify mode, Node apps), or when polling the port / health
   * path succeeds, whichever is first. With a health path, a listen notification is not enough:
   * the health check must pass too.
   */
  private async waitReady(svc: Service, name: string, port: number, deadline: number, notified?: Promise<void>): Promise<void> {
    let checks = 0;
    let listening = false;
    notified?.then(() => (listening = true));
    const interval = Math.max(1, this.store.getSettings().pollIntervalMs);
    while (Date.now() < deadline) {
      if (listening && !svc.healthPath) return;
      const ok = svc.healthPath ? await probeHttp(port, svc.healthPath) : await probeTcp(port);
      if (ok) return;
      // Every ~1.5s make sure the process hasn't died.
      if (++checks % 10 === 0) {
        const p = await pm2.describe(name).catch(() => null);
        if (!p || p.status === 'errored' || p.status === 'stopped') {
          const tail = tailFile(p?.errLog ?? '', 600).trim();
          throw new Error(`process exited during startup${tail ? `:\n${tail}` : ''}`);
        }
      }
      // Sleep until the next poll, or wake early on the listen notification.
      // (Once it has fired, only the timer paces the health-check polls.)
      await Promise.race([new Promise((r) => setTimeout(r, interval)), !listening && notified ? notified : new Promise(() => {})]);
    }
    throw new Error(`did not become ready on port ${port} within ${svc.startTimeoutSec}s`);
  }

  async stop(svcId: number, reason = 'manual'): Promise<void> {
    const svc = this.store.getService(svcId);
    const app = svc && this.store.getApp(svc.appId);
    if (!svc || !app || svc.kind !== 'process') return;
    await this.pending.get(svcId)?.catch(() => {});
    this.set(svcId, { state: 'stopping' });
    try {
      await pm2.stop(pm2Name(app, svc));
      const c = this.procCache.get(pm2Name(app, svc));
      if (c) c.status = 'stopped';
      console.log(`[lifecycle] ${pm2Name(app, svc)} stopped (${reason})`);
      this.emit('usage', { ev: 'stop', svc: pm2Name(app, svc), reason: reason.startsWith('idle') ? 'idle' : reason });
    } finally {
      this.set(svcId, { state: 'stopped', pid: 0, memory: 0, cpu: 0 });
    }
  }

  async restart(svcId: number): Promise<void> {
    await this.stop(svcId, 'restart');
    await this.ensureReady(svcId);
  }

  /** Remove pm2 processes for a service that is being deleted or renamed. */
  async forget(app: App, svc: Service): Promise<void> {
    // A start still in flight would otherwise recreate the process right after we remove it.
    await this.pending.get(svc.id)?.catch(() => {});
    await pm2.remove(pm2Name(app, svc)).catch(() => {});
    this.runtimes.delete(svc.id);
    this.emit('change', svc.id);
  }

  /** Called when the proxy gets ECONNREFUSED from a service we thought was up. */
  markDown(svcId: number): void {
    if (this.rt(svcId).state === 'ready') this.set(svcId, { state: 'stopped' });
  }

  // ---- background loop ----

  async boot(): Promise<void> {
    await this.sync();
    for (const svc of this.store.listServices()) {
      if (svc.kind === 'static') this.set(svc.id, { state: 'ready' });
      else if (this.idleTimeoutSec(svc) === 0 && this.rt(svc.id).state !== 'ready') {
        this.ensureReady(svc.id).catch(() => {});
      }
    }
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[lifecycle] tick', e)), REAP_INTERVAL_MS);
    this.timer.unref();
  }

  /** Running process services and their RSS, for the usage log. */
  running(): { svc: string; rss: number; pid: number }[] {
    const apps = new Map(this.store.listApps().map((a) => [a.id, a]));
    const out: { svc: string; rss: number; pid: number }[] = [];
    for (const svc of this.store.listServices()) {
      const app = apps.get(svc.appId);
      const r = this.rt(svc.id);
      if (app && svc.kind === 'process' && r.state === 'ready') out.push({ svc: pm2Name(app, svc), rss: r.memory, pid: r.pid });
    }
    return out;
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    await this.sync();
    const now = Date.now();
    for (const svc of this.store.listServices()) {
      if (svc.kind !== 'process') continue;
      const r = this.rt(svc.id);
      const idle = this.idleTimeoutSec(svc);
      if (r.state !== 'ready' || idle === 0 || r.inflight > 0 || r.sockets > 0) continue;
      if (now - r.lastActivity > idle * 1000) {
        this.stop(svc.id, `idle ${Math.round((now - r.lastActivity) / 1000)}s`).catch((e) => console.error(e));
      }
    }
  }

  /** Remove processes in our pm2 namespace that no longer belong to any service (deleted/renamed mid-start). */
  private reapOrphans(procs: pm2.Pm2Proc[], apps: Map<number, App>): void {
    const known = new Set<string>();
    for (const svc of this.store.listServices()) {
      const app = apps.get(svc.appId);
      if (app) known.add(pm2Name(app, svc));
    }
    for (const p of procs) {
      if (!isManagedName(p) || known.has(p.name)) continue;
      console.log(`[lifecycle] removing orphaned pm2 process ${p.name}`);
      pm2.remove(p.name).catch((e) => console.error(`[lifecycle] could not remove ${p.name}`, e));
    }
  }

  /** Pull status + stats from pm2 and reconcile state (adopts running processes after a gateway restart). */
  private async sync(): Promise<void> {
    const procs = await pm2.list().catch(() => [] as pm2.Pm2Proc[]);
    this.procCache = new Map(procs.map((p) => [p.name, p]));
    const byName = new Map(procs.map((p) => [p.name, p]));
    const apps = new Map(this.store.listApps().map((a) => [a.id, a]));
    this.reapOrphans(procs, apps);
    for (const svc of this.store.listServices()) {
      if (svc.kind !== 'process') continue;
      const app = apps.get(svc.appId);
      if (!app) continue;
      const p = byName.get(pm2Name(app, svc));
      const r = this.rt(svc.id);
      const stats = { memory: p?.memory ?? 0, cpu: p?.cpu ?? 0, restarts: p?.restarts ?? 0, pid: p?.pid ?? 0 };
      if (r.state === 'starting' || r.state === 'stopping') {
        Object.assign(r, stats);
        continue;
      }
      const online = p?.status === 'online';
      if (online && r.state !== 'ready' && svc.port != null && (await probeTcp(svc.port))) {
        this.set(svc.id, { ...stats, state: 'ready', startedAt: p!.uptime, lastActivity: r.lastActivity || Date.now() });
      } else if (!online && r.state === 'ready') {
        this.set(svc.id, { ...stats, state: p?.status === 'errored' ? 'error' : 'stopped', error: p?.status === 'errored' ? 'process crashed (see logs)' : '' });
      } else {
        const changed = r.memory !== stats.memory || r.cpu !== stats.cpu;
        Object.assign(r, stats);
        if (changed) this.emit('change', svc.id);
      }
    }
  }
}
