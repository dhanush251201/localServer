import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

let cached: { value: string | null; at: number } | null = null;

/** Cached for 15s: it shells out to route/ifconfig, and the dashboard asks on every state update. */
export function lanAddress(): string | null {
  if (cached && Date.now() - cached.at < 15_000) return cached.value;
  cached = { value: readLanAddress(), at: Date.now() };
  return cached.value;
}

/**
 * The address other devices can reach this Mac on, taken from the interface that carries the
 * default route. Prefers a real IPv4 address; on IPv6-only networks (e.g. T-Mobile hotspots) it
 * falls back to the stable global IPv6 address. Skips addresses no other device can use:
 * 192.0.0.x (macOS's CLAT translation address on IPv6-only networks), 169.254.x, link-local,
 * temporary/privacy IPv6 and CLAT IPv6.
 */
function readLanAddress(): string | null {
  const iface = run('route', ['-n', 'get', 'default']).match(/interface:\s*(\S+)/)?.[1] ?? 'en0';
  const lines = run('ifconfig', [iface]).split('\n');
  let v6: string | null = null;
  for (const line of lines) {
    const m4 = line.match(/^\s*inet (\d+\.\d+\.\d+\.\d+)/);
    if (m4 && !m4[1].startsWith('192.0.0.') && !m4[1].startsWith('169.254.') && !m4[1].startsWith('127.')) return m4[1];
    const m6 = line.match(/^\s*inet6 ([0-9a-f:]+)\s/i);
    if (m6 && !v6 && !/^fe80/i.test(m6[1]) && !/temporary|clat46|deprecated/.test(line)) v6 = m6[1];
  }
  return v6;
}

/**
 * Publishes "<name>.local → LAN IP" over Bonjour using macOS's own mDNSResponder
 * (`dns-sd -P`), one long-lived child per hostname. Phones on the same Wi-Fi resolve these natively.
 */
export class MdnsPublisher {
  private children = new Map<string, ChildProcess>();
  private ip: string | null = null;
  private port = 80;

  sync(hosts: string[], port: number): void {
    const ip = lanAddress();
    const wanted = new Set(
      hosts.filter((h) => h.endsWith('.local') && h.split('.').length === 2), // single-label only
    );
    const ipChanged = ip !== this.ip || port !== this.port;
    this.ip = ip;
    this.port = port;

    for (const [host, child] of this.children) {
      if (!wanted.has(host) || ipChanged || !ip) {
        child.kill();
        this.children.delete(host);
      }
    }
    if (!ip) return;
    for (const host of wanted) {
      if (this.children.has(host)) continue;
      const label = host.slice(0, -'.local'.length);
      const child = spawn('dns-sd', ['-P', `localserver ${label}`, '_http._tcp', 'local', String(port), host, ip], {
        stdio: 'ignore',
      });
      child.on('exit', () => {
        if (this.children.get(host) === child) this.children.delete(host);
      });
      child.on('error', (e) => console.error(`[mdns] ${host}: ${e.message}`));
      this.children.set(host, child);
    }
  }

  published(): { host: string; ip: string | null }[] {
    return [...this.children.keys()].map((host) => ({ host, ip: this.ip }));
  }

  stop(): void {
    for (const c of this.children.values()) c.kill();
    this.children.clear();
  }
}
