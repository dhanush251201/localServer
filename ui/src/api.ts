export type Kind = 'static' | 'process';
export type State = 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';

export interface Runtime {
  state: State;
  error: string;
  lastActivity: number;
  inflight: number;
  sockets: number;
  startedAt: number;
  lastStartMs: number;
  memory: number;
  cpu: number;
  restarts: number;
  pid: number;
  idleStopAt: number | null;
}

export interface Service {
  id: number;
  appId: number;
  name: string;
  slug: string;
  kind: Kind;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  interpreter: string;
  port: number | null;
  healthPath: string;
  idleTimeoutSec: number;
  startTimeoutSec: number;
  preserveHost: boolean;
  distDir: string;
  spaFallback: boolean;
  buildCommand: string;
  lanVisible: boolean;
  // computed
  pm2Name: string | null;
  effectiveIdleTimeoutSec: number;
  runtime: Runtime;
  build: { status: 'running' | 'ok' | 'failed'; exitCode: number | null; startedAt: number; endedAt: number } | null;
}

export interface Route {
  id: number;
  appId: number;
  serviceId: number;
  host: string;
  pathPrefix: string;
  stripPrefix: boolean;
}

export interface App {
  id: number;
  name: string;
  slug: string;
  domains: string[];
  services: Service[];
  routes: Route[];
}

export interface Settings {
  listenPort: number;
  defaultIdleTimeoutSec: number;
  portRangeStart: number;
  portRangeEnd: number;
  lanEnabled: boolean;
  adminPasswordSet: boolean;
  adminHosts: string[];
}

export interface GatewayState {
  now: number;
  settings: Settings;
  lanIp: string | null;
  mdns: { host: string; ip: string | null }[];
  apps: App[];
}

export interface Pm2Proc {
  name: string;
  status: string;
  namespace: string;
  cwd: string;
  script: string;
  args: string[];
  interpreter: string;
  port: number | null;
  memory: number;
  cron: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-localserver': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  get: <T>(p: string) => req<T>('GET', p),
  post: <T>(p: string, b?: unknown) => req<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => req<T>('PATCH', p, b),
  del: <T>(p: string) => req<T>('DELETE', p),
};

// ---- small helpers shared by components ----

/** Split a command line into args, honouring simple quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (/[\s"']/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ');
}

export function parseEnv(s: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function fmtBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtAgo(ts: number, now: number): string {
  if (!ts) return 'never';
  return `${fmtDuration(now - ts)} ago`;
}

/** Link to an app domain using the same port the admin UI is being served on. */
export function hostUrl(host: string, path = '/'): string {
  const port = window.location.port;
  return `http://${host}${port ? `:${port}` : ''}${path}`;
}
