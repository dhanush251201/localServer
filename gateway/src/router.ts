import type { App, Route, Service } from './types.ts';
import type { Store } from './db.ts';

export interface Match {
  app: App;
  service: Service;
  route: Route;
  /** Path to forward upstream (prefix removed when stripPrefix is set). */
  upstreamPath: string;
}

function prefixMatches(prefix: string, pathname: string): boolean {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * Picks the most specific route for host + path.
 * An explicit route host beats "any app domain"; then the longest path prefix wins.
 */
export class Router {
  private store: Store;
  private table: { app: App; route: Route; service: Service; hosts: Set<string> }[] = [];

  constructor(store: Store) {
    this.store = store;
    this.reload();
  }

  reload(): void {
    const apps = new Map(this.store.listApps().map((a) => [a.id, a]));
    const services = new Map(this.store.listServices().map((s) => [s.id, s]));
    this.table = [];
    for (const route of this.store.listRoutes()) {
      const app = apps.get(route.appId);
      const service = services.get(route.serviceId);
      if (!app || !service) continue;
      const hosts = new Set(route.host ? [route.host] : app.domains);
      this.table.push({ app, route, service, hosts });
    }
  }

  /** True when any app claims this hostname (so it must not fall through to the admin UI). */
  knowsHost(host: string): boolean {
    return this.table.some((e) => e.hosts.has(host));
  }

  match(host: string, url: string): Match | null {
    const qIdx = url.indexOf('?');
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const search = qIdx === -1 ? '' : url.slice(qIdx);

    let best: (typeof this.table)[number] | null = null;
    let bestScore = -1;
    for (const e of this.table) {
      if (!e.hosts.has(host) || !prefixMatches(e.route.pathPrefix, pathname)) continue;
      const score = (e.route.host ? 100_000 : 0) + e.route.pathPrefix.length;
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    if (!best) return null;

    let upstreamPath = pathname;
    if (best.route.stripPrefix && best.route.pathPrefix !== '/') {
      upstreamPath = pathname.slice(best.route.pathPrefix.length) || '/';
    }
    return { app: best.app, service: best.service, route: best.route, upstreamPath: upstreamPath + search };
  }
}
