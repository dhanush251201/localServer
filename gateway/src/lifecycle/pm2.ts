import pm2 from 'pm2';
import { performance } from 'node:perf_hooks';

export const PM2_NAMESPACE = 'localserver';

export interface Pm2Proc {
  name: string;
  pmId: number;
  pid: number;
  status: string;
  namespace: string;
  cwd: string;
  script: string;
  args: string[];
  interpreter: string;
  env: Record<string, string>;
  memory: number;
  cpu: number;
  uptime: number;
  restarts: number;
  outLog: string;
  errLog: string;
  /** cron_restart schedule, if this is a scheduled job. */
  cron: string;
}

function call<T>(fn: (cb: (err: Error | null, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));
}

let connected: Promise<void> | null = null;

export function connect(): Promise<void> {
  connected ??= call<void>((cb) => pm2.connect(false, cb as never)).catch((e) => {
    connected = null;
    throw e;
  });
  return connected;
}

export function disconnect(): void {
  if (connected) pm2.disconnect();
  connected = null;
}

// pm2's typings are loose; normalise what we read back.
function toProc(p: any): Pm2Proc {
  const e = p.pm2_env ?? {};
  const rawArgs = e.args ?? [];
  return {
    name: p.name,
    pmId: p.pm_id,
    pid: p.pid ?? 0,
    status: e.status ?? 'unknown',
    namespace: e.namespace ?? 'default',
    cwd: e.pm_cwd ?? '',
    script: e.pm_exec_path ?? '',
    args: Array.isArray(rawArgs) ? rawArgs.map(String) : String(rawArgs).split(' ').filter(Boolean),
    interpreter: e.exec_interpreter ?? '',
    env: Object.fromEntries(Object.entries(e.env ?? {}).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, String(v)])),
    memory: p.monit?.memory ?? 0,
    cpu: p.monit?.cpu ?? 0,
    uptime: e.pm_uptime ?? 0,
    restarts: e.restart_time ?? 0,
    outLog: e.pm_out_log_path ?? '',
    errLog: e.pm_err_log_path ?? '',
    cron: e.cron_restart ? String(e.cron_restart) : '',
  };
}

export async function list(): Promise<Pm2Proc[]> {
  await connect();
  const procs = await call<any[]>((cb) => pm2.list(cb as never));
  return procs.map(toProc);
}

export async function describe(name: string): Promise<Pm2Proc | null> {
  await connect();
  const procs = await call<any[]>((cb) => pm2.describe(name, cb as never));
  return procs.length ? toProc(procs[0]) : null;
}

export interface StartSpec {
  name: string;
  script: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  interpreter: string;
  outLog: string;
  errLog: string;
  /** Load pm2's @pm2/io agent into the app (pm2's default). */
  instrumentation?: boolean;
}

/** Returns how long removing the old definition and the start call itself took (ms). */
export async function start(spec: StartSpec): Promise<{ removeMs: number; startMs: number }> {
  await connect();
  // Always start from a fresh definition so edits to command/env/port take effect.
  const t0 = performance.now();
  await remove(spec.name);
  const t1 = performance.now();
  const opts: Record<string, unknown> = {
    name: spec.name,
    namespace: PM2_NAMESPACE,
    script: spec.script,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    // Don't inherit the gateway's own environment (it contains pm2 internals like pm_id).
    filter_env: true,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 5,
    min_uptime: 5000,
    restart_delay: 1000,
    output: spec.outLog,
    error: spec.errLog,
    merge_logs: true,
    time: true,
  };
  if (spec.interpreter && spec.interpreter !== 'auto') opts.interpreter = spec.interpreter;
  if (spec.instrumentation === false) opts.pmx = false;
  await call((cb) => pm2.start(opts as never, cb as never));
  return { removeMs: t1 - t0, startMs: performance.now() - t1 };
}

/**
 * Start an existing, stopped pm2 process from its stored definition. Uses the daemon's own
 * startProcessId operation: pm2.restart() would run its full restart logic (stop, reset, start).
 */
export async function startExisting(pmId: number): Promise<{ removeMs: number; startMs: number }> {
  await connect();
  const t0 = performance.now();
  await call((cb) => (pm2 as any).Client.executeRemote('startProcessId', pmId, cb));
  return { removeMs: 0, startMs: performance.now() - t0 };
}

export async function stop(name: string): Promise<void> {
  await connect();
  try {
    await call((cb) => pm2.stop(name, cb as never));
  } catch (e) {
    if (!/not found/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

export async function remove(name: string): Promise<void> {
  await connect();
  try {
    await call((cb) => pm2.delete(name, cb as never));
  } catch (e) {
    if (!/not found/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}
