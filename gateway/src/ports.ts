import { createServer } from 'node:net';

/** Resolves true if nothing is listening on the port (checks both stacks). */
export function isPortFree(port: number): Promise<boolean> {
  const tryBind = (host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  return tryBind('127.0.0.1').then((ok) => (ok ? tryBind('::') : false));
}

export async function allocatePort(start: number, end: number, taken: Set<number>): Promise<number> {
  for (let p = start; p <= end; p++) {
    if (taken.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port in ${start}-${end}`);
}
