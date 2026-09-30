import { createServer, type Server } from 'node:net';
import { rmSync } from 'node:fs';

/**
 * Collects "I'm listening" notifications from ready-probe.cjs over a Unix socket, so a starting
 * service is detected the moment it calls listen() rather than at the next poll.
 */
export class ReadyHub {
  readonly path: string;
  private server: Server | null = null;
  private waiters = new Map<string, Set<() => void>>();

  constructor(path: string) {
    this.path = path;
  }

  start(): Promise<void> {
    rmSync(this.path, { force: true });
    return new Promise((resolve, reject) => {
      const s = createServer((c) => {
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => (buf += d));
        c.on('end', () => this.fire(buf.trim()));
        c.on('error', () => {});
      });
      s.once('error', reject);
      s.listen(this.path, () => {
        this.server = s;
        resolve();
      });
    });
  }

  /** Resolves when `name` reports it is listening. Call before starting the process. */
  wait(name: string): { promise: Promise<void>; cancel(): void } {
    let done!: () => void;
    const promise = new Promise<void>((r) => (done = r));
    const set = this.waiters.get(name) ?? new Set();
    set.add(done);
    this.waiters.set(name, set);
    return { promise, cancel: () => set.delete(done) };
  }

  private fire(name: string): void {
    const set = this.waiters.get(name);
    if (!set) return;
    this.waiters.delete(name);
    for (const f of set) f();
  }

  close(): void {
    this.server?.close();
    rmSync(this.path, { force: true });
  }
}
