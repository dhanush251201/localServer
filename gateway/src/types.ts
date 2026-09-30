export type ServiceKind = 'static' | 'process';

export interface App {
  id: number;
  name: string;
  slug: string;
  /** Hostnames that belong to this app, e.g. time.localhost, time.local */
  domains: string[];
}

export interface Service {
  id: number;
  appId: number;
  name: string;
  slug: string;
  kind: ServiceKind;

  // process services
  cwd: string;
  /** Script path or executable, e.g. server.js, npm, /usr/bin/python3 */
  command: string;
  /** Arguments; "{port}" is replaced with the assigned port. */
  args: string[];
  env: Record<string, string>;
  /** 'auto' lets pm2 decide (node for .js files, direct exec otherwise). */
  interpreter: string;
  port: number | null;
  /** Probe this path over HTTP for readiness; empty = TCP connect only. */
  healthPath: string;
  /** Seconds without traffic before the process is stopped. 0 = always on. */
  idleTimeoutSec: number;
  startTimeoutSec: number;
  /** Forward the browser's Host header instead of rewriting it to localhost:port. */
  preserveHost: boolean;

  // static services
  distDir: string;
  spaFallback: boolean;

  // both
  buildCommand: string;
  lanVisible: boolean;
}

export interface Route {
  id: number;
  appId: number;
  serviceId: number;
  /** Empty = any of the app's domains. */
  host: string;
  pathPrefix: string;
  stripPrefix: boolean;
}

export interface Settings {
  listenPort: number;
  defaultIdleTimeoutSec: number;
  portRangeStart: number;
  portRangeEnd: number;
  /** Accept connections from other devices and publish .local names over mDNS. */
  lanEnabled: boolean;
  /** Required for admin access from non-loopback clients. Empty = LAN admin disabled. */
  adminPassword: string;
  adminHosts: string[];
  /** 'notify': managed Node processes report listen() over a Unix socket (polling stays as a fallback). */
  readiness: 'notify' | 'poll';
  /** Fallback TCP/HTTP readiness polling interval. */
  pollIntervalMs: number;
  /** Give each process service a persistent V8 compile cache (NODE_COMPILE_CACHE). */
  compileCache: boolean;
  /**
   * pm2 injects its @pm2/io monitoring agent into every app by default, costing ~30 ms per start.
   * Off unless you use PM2.io custom metrics.
   */
  pm2Instrumentation: boolean;
  /**
   * Skip avoidable pm2 round trips on a cold start: use the cached process list instead of a
   * describe call, and restart the existing stopped process when its definition is unchanged
   * instead of deleting and re-creating it.
   */
  fastControlPath: boolean;
}

export type ServiceState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
