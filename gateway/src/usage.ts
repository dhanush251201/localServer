import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

/**
 * Append-only usage log (one JSON object per line, one file per day) for studying keep-alive
 * policies: when each service is requested, how long cold starts take, when it is stopped, and
 * how much memory is in use. It records service names and timings only: no URLs, paths or IPs.
 */
export class UsageLog {
  private dir: string;
  private day = '';
  private out: WriteStream | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sampleWith: (procs: unknown[]) => void = () => {};

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  write(event: Record<string, unknown>): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.out?.end();
      this.out = createWriteStream(join(this.dir, `usage-${day}.jsonl`), { flags: 'a' });
      this.out.on('error', (e) => console.error('[usage]', e.message));
      this.day = day;
    }
    this.out!.write(JSON.stringify({ t: now.getTime(), ...event }) + '\n');
  }

  /** Every `ms`, record system memory, load, power source and the RSS of each running service. */
  startSampling(ms: number, running: () => { svc: string; rss: number; pid?: number }[]): void {
    const sample = () =>
      execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 2000, maxBuffer: 4 << 20 }, (_e, psOut) => {
        // RSS of each service's whole process tree: pm2 reports only the main process, but dev
        // servers spawn helpers (Vite runs esbuild) that are part of what keeping it warm costs.
        const kids = new Map<number, number[]>();
        const rssKb = new Map<number, number>();
        for (const line of (psOut ?? '').split('\n')) {
          const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
          if (!pid) continue;
          rssKb.set(pid, rss);
          kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
        }
        const treeBytes = (root: number) => {
          let total = 0;
          const stack = [root];
          while (stack.length) {
            const p = stack.pop()!;
            total += (rssKb.get(p) ?? 0) * 1024;
            stack.push(...(kids.get(p) ?? []));
          }
          return total;
        };
        const procs = running().map((r) => (r.pid ? { ...r, treeRss: treeBytes(r.pid) } : r));
        this.sampleWith(procs);
      });
    this.sampleWith = (procs) =>
      execFile('pmset', ['-g', 'batt'], { timeout: 2000 }, (_err, stdout) => {
        const power = /AC Power/.test(stdout ?? '') ? 'ac' : /Battery Power/.test(stdout ?? '') ? 'battery' : 'unknown';
        const battery = Number((stdout ?? '').match(/(\d+)%/)?.[1] ?? NaN);
        this.write({
          ev: 'sample',
          freeMem: freemem(),
          totalMem: totalmem(),
          load1: +loadavg()[0].toFixed(2),
          power,
          battery: Number.isFinite(battery) ? battery : null,
          running: procs,
        });
      });
    sample();
    this.timer = setInterval(sample, ms);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.out?.end();
  }
}
