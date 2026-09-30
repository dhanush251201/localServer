import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { App, Route, Service, Settings } from './types.ts';

export const DEFAULT_SETTINGS: Settings = {
  listenPort: 8080,
  defaultIdleTimeoutSec: 600,
  portRangeStart: 7000,
  portRangeEnd: 7999,
  lanEnabled: false,
  adminPassword: '',
  adminHosts: ['localserver.localhost', 'localserver.local', 'localhost', '127.0.0.1', '[::1]'],
  readiness: 'notify',
  pollIntervalMs: 10,
  compileCache: false,
  pm2Instrumentation: false,
  fastControlPath: true,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domains TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (app_id, slug)
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  host TEXT NOT NULL DEFAULT '',
  path_prefix TEXT NOT NULL DEFAULT '/',
  strip_prefix INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const SERVICE_DEFAULTS: Omit<Service, 'id' | 'appId' | 'name' | 'slug' | 'kind'> = {
  cwd: '',
  command: '',
  args: [],
  env: {},
  interpreter: 'auto',
  port: null,
  healthPath: '',
  idleTimeoutSec: -1, // -1 = use the global default
  startTimeoutSec: 30,
  preserveHost: false,
  distDir: '',
  spaFallback: true,
  buildCommand: '',
  lanVisible: true,
};

type Row = Record<string, unknown>;

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/** Lowercase, drop scheme/port/path, so "HTTP://Time.localhost:80/x" → "time.localhost". */
export function normalizeHost(h: string): string {
  let s = h.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0];
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  return s.replace(/:\d+$/, '').replace(/\.$/, '');
}

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  // ---- settings ----

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[];
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if (String(r.key) in DEFAULT_SETTINGS) out[String(r.key)] = JSON.parse(String(r.value));
    }
    return out as unknown as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SETTINGS && v !== undefined) stmt.run(k, JSON.stringify(v));
    }
    return this.getSettings();
  }

  // ---- apps ----

  private rowToApp(r: Row): App {
    return { id: Number(r.id), name: String(r.name), slug: String(r.slug), domains: JSON.parse(String(r.domains)) };
  }

  listApps(): App[] {
    return (this.db.prepare('SELECT * FROM apps ORDER BY name').all() as Row[]).map((r) => this.rowToApp(r));
  }

  getApp(id: number): App | undefined {
    const r = this.db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as Row | undefined;
    return r && this.rowToApp(r);
  }

  createApp(input: { name: string; slug?: string; domains?: string[] }): App {
    const slug = slugify(input.slug || input.name);
    const domains = (input.domains ?? [`${slug}.localhost`]).map(normalizeHost).filter(Boolean);
    const res = this.db
      .prepare('INSERT INTO apps (name, slug, domains) VALUES (?, ?, ?)')
      .run(input.name, slug, JSON.stringify(domains));
    return this.getApp(Number(res.lastInsertRowid))!;
  }

  updateApp(id: number, patch: Partial<Pick<App, 'name' | 'slug' | 'domains'>>): App {
    const cur = this.getApp(id);
    if (!cur) throw new HttpError(404, 'app not found');
    const next = {
      name: patch.name ?? cur.name,
      slug: patch.slug ? slugify(patch.slug) : cur.slug,
      domains: (patch.domains ?? cur.domains).map(normalizeHost).filter(Boolean),
    };
    this.db
      .prepare('UPDATE apps SET name = ?, slug = ?, domains = ? WHERE id = ?')
      .run(next.name, next.slug, JSON.stringify(next.domains), id);
    return this.getApp(id)!;
  }

  deleteApp(id: number): void {
    this.db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  }

  // ---- services ----

  private rowToService(r: Row): Service {
    const data = JSON.parse(String(r.data));
    return {
      ...SERVICE_DEFAULTS,
      ...data,
      id: Number(r.id),
      appId: Number(r.app_id),
      name: String(r.name),
      slug: String(r.slug),
    };
  }

  listServices(appId?: number): Service[] {
    const rows = (
      appId === undefined
        ? this.db.prepare('SELECT * FROM services ORDER BY app_id, id').all()
        : this.db.prepare('SELECT * FROM services WHERE app_id = ? ORDER BY id').all(appId)
    ) as Row[];
    return rows.map((r) => this.rowToService(r));
  }

  getService(id: number): Service | undefined {
    const r = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as Row | undefined;
    return r && this.rowToService(r);
  }

  createService(appId: number, input: Partial<Service> & { name: string; kind: Service['kind'] }): Service {
    if (!this.getApp(appId)) throw new HttpError(404, 'app not found');
    const { id: _id, appId: _a, name, slug, ...rest } = input;
    const data = { ...SERVICE_DEFAULTS, ...pickServiceData(rest) };
    const res = this.db
      .prepare('INSERT INTO services (app_id, name, slug, data) VALUES (?, ?, ?, ?)')
      .run(appId, name, slugify(slug || name), JSON.stringify(data));
    return this.getService(Number(res.lastInsertRowid))!;
  }

  updateService(id: number, patch: Partial<Service>): Service {
    const cur = this.getService(id);
    if (!cur) throw new HttpError(404, 'service not found');
    const { id: _id, appId: _a, name, slug, ...rest } = { ...cur, ...patch };
    const data = pickServiceData(rest);
    this.db
      .prepare('UPDATE services SET name = ?, slug = ?, data = ? WHERE id = ?')
      .run(name, slugify(slug || name), JSON.stringify(data), id);
    return this.getService(id)!;
  }

  deleteService(id: number): void {
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id);
  }

  // ---- routes ----

  private rowToRoute(r: Row): Route {
    return {
      id: Number(r.id),
      appId: Number(r.app_id),
      serviceId: Number(r.service_id),
      host: String(r.host),
      pathPrefix: String(r.path_prefix),
      stripPrefix: Boolean(r.strip_prefix),
    };
  }

  listRoutes(appId?: number): Route[] {
    const rows = (
      appId === undefined
        ? this.db.prepare('SELECT * FROM routes ORDER BY app_id, id').all()
        : this.db.prepare('SELECT * FROM routes WHERE app_id = ? ORDER BY id').all(appId)
    ) as Row[];
    return rows.map((r) => this.rowToRoute(r));
  }

  createRoute(appId: number, input: Partial<Route> & { serviceId: number }): Route {
    const svc = this.getService(input.serviceId);
    if (!svc || svc.appId !== appId) throw new HttpError(400, 'service does not belong to this app');
    const res = this.db
      .prepare('INSERT INTO routes (app_id, service_id, host, path_prefix, strip_prefix) VALUES (?, ?, ?, ?, ?)')
      .run(appId, input.serviceId, normalizeHost(input.host ?? ''), normalizePrefix(input.pathPrefix), input.stripPrefix ? 1 : 0);
    return this.rowToRoute(this.db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(res.lastInsertRowid)) as Row);
  }

  updateRoute(id: number, patch: Partial<Route>): Route {
    const cur = this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as Row | undefined;
    if (!cur) throw new HttpError(404, 'route not found');
    const r = { ...this.rowToRoute(cur), ...patch };
    this.db
      .prepare('UPDATE routes SET service_id = ?, host = ?, path_prefix = ?, strip_prefix = ? WHERE id = ?')
      .run(r.serviceId, normalizeHost(r.host), normalizePrefix(r.pathPrefix), r.stripPrefix ? 1 : 0, id);
    return this.rowToRoute(this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as Row);
  }

  deleteRoute(id: number): void {
    this.db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  }
}

export function normalizePrefix(p: string | undefined): string {
  let s = (p ?? '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function pickServiceData(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SERVICE_DEFAULTS)) if (k in src) out[k] = src[k];
  if ('kind' in src) out.kind = src.kind;
  return out;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
