import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface Job {
  id: string;
  serviceId: number;
  command: string;
  cwd: string;
  status: 'running' | 'ok' | 'failed';
  exitCode: number | null;
  output: string;
  startedAt: number;
  endedAt: number;
}

const MAX_OUTPUT = 200_000;

/** Runs one-off shell commands (builds) and streams their output. Keeps the latest job per service. */
export class JobRunner extends EventEmitter {
  private jobs = new Map<number, Job>();

  latest(serviceId: number): Job | undefined {
    return this.jobs.get(serviceId);
  }

  run(serviceId: number, command: string, cwd: string, env: Record<string, string> = {}): Job {
    const cur = this.jobs.get(serviceId);
    if (cur?.status === 'running') return cur;
    const job: Job = {
      id: `${serviceId}-${Date.now()}`,
      serviceId,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      output: `$ ${command}\n`,
      startedAt: Date.now(),
      endedAt: 0,
    };
    this.jobs.set(serviceId, job);

    const child = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0', ...env } });
    const onData = (d: Buffer) => {
      const s = d.toString();
      job.output = (job.output + s).slice(-MAX_OUTPUT);
      this.emit('output', job, s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => onData(Buffer.from(`\n${e.message}\n`)));
    child.on('close', (code) => {
      job.exitCode = code;
      job.status = code === 0 ? 'ok' : 'failed';
      job.endedAt = Date.now();
      onData(Buffer.from(`\n[exit ${code}] in ${((job.endedAt - job.startedAt) / 1000).toFixed(1)}s\n`));
      this.emit('done', job);
    });
    this.emit('start', job);
    return job;
  }
}
