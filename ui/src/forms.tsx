import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  fmtBytes,
  formatEnv,
  joinArgs,
  parseEnv,
  splitArgs,
  type App,
  type GatewayState,
  type Kind,
  type Pm2Proc,
  type Route,
  type Service,
} from './api.ts';
import { Modal } from './Modal.tsx';

function useSubmit(fn: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Footer({ error, busy, onCancel, onSubmit, label, extra }: { error: string; busy: boolean; onCancel(): void; onSubmit(): void; label: string; extra?: ReactNode }) {
  return (
    <>
      {error ? <span className="err">{error}</span> : extra}
      <button onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={busy} onClick={onSubmit}>
        {busy ? 'Saving…' : label}
      </button>
    </>
  );
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------------------
// App

export function AppForm({ app, onClose }: { app?: App; onClose(): void }) {
  const [name, setName] = useState(app?.name ?? '');
  const [slug, setSlug] = useState(app?.slug ?? '');
  const [domains, setDomains] = useState(app?.domains.join('\n') ?? '');
  const [touchedDomains, setTouchedDomains] = useState(Boolean(app));
  const autoSlug = slug || slugify(name);
  const domainText = touchedDomains ? domains : autoSlug ? `${autoSlug}.localhost\n${autoSlug}.local` : '';

  const submit = useSubmit(() => {
    const body = { name, slug: autoSlug, domains: domainText.split(/[\s,]+/).filter(Boolean) };
    return app ? api.patch(`/_api/apps/${app.id}`, body) : api.post('/_api/apps', body);
  }, onClose);

  return (
    <Modal
      title={app ? `Edit ${app.name}` : 'New app'}
      onClose={onClose}
      footer={<Footer {...submit} onCancel={onClose} onSubmit={submit.run} label={app ? 'Save' : 'Create app'} />}
    >
      <div className="stack">
        <div className="grid2">
          <label className="field">
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Time Tracker" />
          </label>
          <label className="field">
            Slug <span className="hint">Used in pm2 process names</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(name) || 'time'} />
          </label>
        </div>
        <label className="field">
          Domains <span className="hint">One per line. *.localhost works on this Mac; single-label *.local names are published to your LAN in LAN mode.</span>
          <textarea
            rows={3}
            value={domainText}
            onChange={(e) => {
              setTouchedDomains(true);
              setDomains(e.target.value);
            }}
          />
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Service

type Draft = {
  name: string;
  kind: Kind;
  cwd: string;
  command: string;
  args: string;
  env: string;
  port: string;
  interpreter: string;
  healthPath: string;
  idleMode: 'default' | 'custom' | 'always';
  idleMinutes: string;
  startTimeoutSec: string;
  preserveHost: boolean;
  distDir: string;
  spaFallback: boolean;
  buildCommand: string;
  lanVisible: boolean;
  routePrefix: string;
};

function toDraft(s?: Service): Draft {
  return {
    name: s?.name ?? '',
    kind: s?.kind ?? 'process',
    cwd: s?.cwd ?? '',
    command: s?.command ?? '',
    args: joinArgs(s?.args ?? []),
    env: formatEnv(s?.env ?? {}),
    port: s?.port != null ? String(s.port) : '',
    interpreter: s?.interpreter ?? 'auto',
    healthPath: s?.healthPath ?? '',
    idleMode: !s || s.idleTimeoutSec < 0 ? 'default' : s.idleTimeoutSec === 0 ? 'always' : 'custom',
    idleMinutes: s && s.idleTimeoutSec > 0 ? String(+(s.idleTimeoutSec / 60).toFixed(2)) : '10',
    startTimeoutSec: String(s?.startTimeoutSec ?? 30),
    preserveHost: s?.preserveHost ?? false,
    distDir: s?.distDir ?? 'dist',
    spaFallback: s?.spaFallback ?? true,
    buildCommand: s?.buildCommand ?? '',
    lanVisible: s?.lanVisible ?? true,
    routePrefix: '/',
  };
}

const PRESETS: { label: string; apply: Partial<Draft> }[] = [
  { label: 'Node server', apply: { kind: 'process', command: 'server.js', args: '', interpreter: 'auto' } },
  { label: 'npm start', apply: { kind: 'process', command: 'npm', args: 'start', interpreter: 'auto' } },
  { label: 'Vite dev server', apply: { kind: 'process', command: 'npx', args: 'vite --port {port} --strictPort --host 127.0.0.1', interpreter: 'auto' } },
  { label: 'Python', apply: { kind: 'process', command: 'python3', args: 'app.py', interpreter: 'auto' } },
  { label: 'Static build (dist/)', apply: { kind: 'static', distDir: 'dist', buildCommand: 'npm run build', spaFallback: true } },
];

export function ServiceForm({ app, service, onClose }: { app: App; service?: Service; onClose(): void }) {
  const [d, setD] = useState<Draft>(() => {
    const draft = toDraft(service);
    // Sensible default for a second service: it's usually the API.
    if (!service && app.services.length > 0) draft.routePrefix = '/api';
    return draft;
  });
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  const submit = useSubmit(async () => {
    const idleTimeoutSec = d.idleMode === 'default' ? -1 : d.idleMode === 'always' ? 0 : Math.max(1, Math.round(Number(d.idleMinutes) * 60));
    const body: Record<string, unknown> = {
      name: d.name || (d.kind === 'static' ? 'web' : 'api'),
      kind: d.kind,
      cwd: d.cwd.trim(),
      command: d.command.trim(),
      args: splitArgs(d.args),
      env: parseEnv(d.env),
      port: d.port.trim() ? Number(d.port) : null,
      interpreter: d.interpreter.trim() || 'auto',
      healthPath: d.healthPath.trim(),
      idleTimeoutSec,
      startTimeoutSec: Number(d.startTimeoutSec) || 30,
      preserveHost: d.preserveHost,
      distDir: d.distDir.trim(),
      spaFallback: d.spaFallback,
      buildCommand: d.buildCommand.trim(),
      lanVisible: d.lanVisible,
    };
    if (service) return api.patch(`/_api/services/${service.id}`, body);
    return api.post(`/_api/apps/${app.id}/services`, { ...body, route: d.routePrefix.trim() ? { pathPrefix: d.routePrefix.trim() } : undefined });
  }, onClose);

  const isProc = d.kind === 'process';
  return (
    <Modal
      title={service ? `Edit ${app.name} · ${service.name}` : `Add service to ${app.name}`}
      onClose={onClose}
      wide
      footer={<Footer {...submit} onCancel={onClose} onSubmit={submit.run} label={service ? 'Save' : 'Add service'} extra={service && service.runtime.state === 'ready' && isProc ? <span className="svc-sub" style={{ marginRight: 'auto' }}>Saving restarts the process if its command changed.</span> : undefined} />}
    >
      <div className="stack">
        {!service && (
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.label} className="sm" onClick={() => set(p.apply)}>
                {p.label}
              </button>
            ))}
          </div>
        )}
        <div className="grid2">
          <label className="field">
            Name
            <input autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={isProc ? 'api' : 'web'} />
          </label>
          <div className="field" style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
            Type
            <div className="seg">
              <button className={isProc ? 'on' : ''} onClick={() => set({ kind: 'process' })}>
                Process (backend / dev server)
              </button>
              <button className={!isProc ? 'on' : ''} onClick={() => set({ kind: 'static' })}>
                Static files
              </button>
            </div>
          </div>
        </div>

        <label className="field">
          Working directory <span className="hint">Absolute path to the project</span>
          <input className="mono" value={d.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder="/Users/you/projects/app/backend" />
        </label>

        {isProc ? (
          <>
            <div className="grid2">
              <label className="field">
                Command <span className="hint">Script (server.js) or executable (npm, python3)</span>
                <input className="mono" value={d.command} onChange={(e) => set({ command: e.target.value })} placeholder="server.js" />
              </label>
              <label className="field">
                Arguments <span className="hint">{'{port}'} is replaced with the assigned port</span>
                <input className="mono" value={d.args} onChange={(e) => set({ args: e.target.value })} placeholder="run dev -- --port {port}" />
              </label>
            </div>
            <div className="grid3">
              <label className="field">
                Port <span className="hint">Blank = auto. Always passed as $PORT.</span>
                <input className="mono" inputMode="numeric" value={d.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} placeholder={service?.port ? String(service.port) : 'auto'} />
              </label>
              <label className="field">
                Health check path <span className="hint">Blank = wait for the port</span>
                <input className="mono" value={d.healthPath} onChange={(e) => set({ healthPath: e.target.value })} placeholder="/api/health" />
              </label>
              <label className="field">
                Start timeout (s)
                <input inputMode="numeric" value={d.startTimeoutSec} onChange={(e) => set({ startTimeoutSec: e.target.value.replace(/\D/g, '') })} />
              </label>
            </div>
            <div className="grid2">
              <label className="field">
                Stop when idle
                <select value={d.idleMode} onChange={(e) => set({ idleMode: e.target.value as Draft['idleMode'] })}>
                  <option value="default">Use global default</option>
                  <option value="custom">After a custom time</option>
                  <option value="always">Never (always on)</option>
                </select>
              </label>
              {d.idleMode === 'custom' ? (
                <label className="field">
                  Idle minutes
                  <input inputMode="decimal" value={d.idleMinutes} onChange={(e) => set({ idleMinutes: e.target.value })} />
                </label>
              ) : (
                <label className="field">
                  Interpreter <span className="hint">auto, none, node, python3…</span>
                  <input className="mono" value={d.interpreter} onChange={(e) => set({ interpreter: e.target.value })} />
                </label>
              )}
            </div>
            <label className="field">
              Environment <span className="hint">KEY=value, one per line</span>
              <textarea rows={3} value={d.env} onChange={(e) => set({ env: e.target.value })} placeholder={'NODE_ENV=production'} />
            </label>
            <label className="check">
              <input type="checkbox" checked={d.preserveHost} onChange={(e) => set({ preserveHost: e.target.checked })} />
              Forward the original Host header <span className="svc-sub">(off = rewrite to localhost:port, which dev servers like vite expect)</span>
            </label>
          </>
        ) : (
          <div className="grid2">
            <label className="field">
              Folder to serve <span className="hint">Relative to the working directory</span>
              <input className="mono" value={d.distDir} onChange={(e) => set({ distDir: e.target.value })} placeholder="dist" />
            </label>
            <label className="check" style={{ alignSelf: 'end', paddingBottom: 8 }}>
              <input type="checkbox" checked={d.spaFallback} onChange={(e) => set({ spaFallback: e.target.checked })} />
              Single-page app (serve index.html for unknown paths)
            </label>
          </div>
        )}

        <div className="grid2">
          <label className="field">
            Build command <span className="hint">Optional, e.g. npm run build</span>
            <input className="mono" value={d.buildCommand} onChange={(e) => set({ buildCommand: e.target.value })} placeholder="npm run build" />
          </label>
          {!service ? (
            <label className="field">
              Route path <span className="hint">Mounts this service on the app's domains; blank = no route</span>
              <input className="mono" value={d.routePrefix} onChange={(e) => set({ routePrefix: e.target.value })} placeholder="/" />
            </label>
          ) : (
            <span />
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={d.lanVisible} onChange={(e) => set({ lanVisible: e.target.checked })} />
          Reachable from other devices when LAN mode is on
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Route

export function RouteForm({ app, route, onClose }: { app: App; route?: Route; onClose(): void }) {
  const [serviceId, setServiceId] = useState(route?.serviceId ?? app.services[0]?.id ?? 0);
  const [host, setHost] = useState(route?.host ?? '');
  const [pathPrefix, setPathPrefix] = useState(route?.pathPrefix ?? '/');
  const [stripPrefix, setStripPrefix] = useState(route?.stripPrefix ?? false);

  const submit = useSubmit(() => {
    const body = { serviceId, host, pathPrefix, stripPrefix };
    return route ? api.patch(`/_api/routes/${route.id}`, body) : api.post(`/_api/apps/${app.id}/routes`, body);
  }, onClose);

  return (
    <Modal title={route ? 'Edit route' : `Add route to ${app.name}`} onClose={onClose} footer={<Footer {...submit} onCancel={onClose} onSubmit={submit.run} label={route ? 'Save' : 'Add route'} />}>
      <div className="stack">
        <label className="field">
          Service
          <select value={serviceId} onChange={(e) => setServiceId(Number(e.target.value))}>
            {app.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.kind})
              </option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <label className="field">
            Host <span className="hint">Blank = all of the app's domains</span>
            <input className="mono" list={`hosts-${app.id}`} value={host} onChange={(e) => setHost(e.target.value)} placeholder={`api.${app.slug}.localhost`} />
            <datalist id={`hosts-${app.id}`}>
              {app.domains.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <label className="field">
            Path prefix
            <input className="mono" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/api" />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={stripPrefix} onChange={(e) => setStripPrefix(e.target.checked)} />
          Strip the prefix before forwarding <span className="svc-sub">(/api/users → /users)</span>
        </label>
        <p className="note">
          The most specific route wins. A route with a host beats one without, then the longest path prefix wins. Subdomain hosts like <code>api.{app.slug}.localhost</code> must also be listed in the app's domains, or they need a DNS entry.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Settings

export function SettingsForm({ state, onClose }: { state: GatewayState; onClose(): void }) {
  const s = state.settings;
  const [idleMin, setIdleMin] = useState(String(+(s.defaultIdleTimeoutSec / 60).toFixed(2)));
  const [listenPort, setListenPort] = useState(String(s.listenPort));
  const [rangeStart, setRangeStart] = useState(String(s.portRangeStart));
  const [rangeEnd, setRangeEnd] = useState(String(s.portRangeEnd));
  const [lan, setLan] = useState(s.lanEnabled);
  const [password, setPassword] = useState('');
  const [clearPw, setClearPw] = useState(false);

  const submit = useSubmit(() => {
    const body: Record<string, unknown> = {
      defaultIdleTimeoutSec: Math.max(1, Math.round(Number(idleMin) * 60)),
      listenPort: Number(listenPort),
      portRangeStart: Number(rangeStart),
      portRangeEnd: Number(rangeEnd),
      lanEnabled: lan,
    };
    if (password) body.adminPassword = password;
    else if (clearPw) body.adminPassword = '';
    return api.patch('/_api/settings', body);
  }, onClose);

  return (
    <Modal title="Settings" onClose={onClose} footer={<Footer {...submit} onCancel={onClose} onSubmit={submit.run} label="Save" />}>
      <div className="stack">
        <div className="grid2">
          <label className="field">
            Default idle timeout (minutes)
            <input inputMode="decimal" value={idleMin} onChange={(e) => setIdleMin(e.target.value)} />
          </label>
          <label className="field">
            Gateway port <span className="hint">pf forwards :80 here</span>
            <input inputMode="numeric" value={listenPort} onChange={(e) => setListenPort(e.target.value)} />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            Auto port range start
            <input inputMode="numeric" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
          </label>
          <label className="field">
            Auto port range end
            <input inputMode="numeric" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
          </label>
        </div>

        <div className="section-title">LAN access</div>
        <label className="check">
          <input type="checkbox" checked={lan} onChange={(e) => setLan(e.target.checked)} />
          Allow other devices on this network and publish <code>.local</code> names
        </label>
        <div className="grid2">
          <label className="field">
            Admin password for LAN <span className="hint">{s.adminPasswordSet ? 'Set. Leave blank to keep it.' : 'Not set. The admin UI is only available on this Mac.'}</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {s.adminPasswordSet && (
            <label className="check" style={{ alignSelf: 'end', paddingBottom: 8 }}>
              <input type="checkbox" checked={clearPw} onChange={(e) => setClearPw(e.target.checked)} />
              Remove password
            </label>
          )}
        </div>
        <div className="note">
          This Mac's LAN address: <code>{state.lanIp ?? 'not connected'}</code>
          {state.mdns.length > 0 && (
            <>
              <br />
              Published: {state.mdns.map((m) => <code key={m.host} style={{ marginRight: 4 }}>{m.host}</code>)}
            </>
          )}
          <br />
          To use URLs without a port on your phone, run <code>sudo ./scripts/setup-pf.sh</code> once. It forwards port 80 to the gateway.
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import from pm2

type ImportRow = { proc: Pm2Proc; selected: boolean; name: string; prefix: string };

function guessPrefix(p: Pm2Proc): string {
  return /backend|\bapi\b|server/i.test(p.name) ? '/api' : '/';
}

function commandFor(p: Pm2Proc): { command: string; args: string[]; port: number | null } {
  const isNpmDev = /\/npm$/.test(p.script) && p.args.includes('dev');
  // Dev servers ignore $PORT, so pass the port on the command line.
  if (isNpmDev) return { command: 'npm', args: [...p.args, '--', '--port', '{port}', '--strictPort'], port: null };
  return { command: p.script, args: p.args, port: p.port };
}

export function ImportDialog({ onClose }: { onClose(): void }) {
  const [procs, setProcs] = useState<Pm2Proc[] | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [appName, setAppName] = useState('');
  const [stopOriginals, setStopOriginals] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    api
      .get<Pm2Proc[]>('/_api/pm2')
      .then((list) => {
        setProcs(list);
        setRows(list.map((p) => ({ proc: p, selected: false, name: p.name, prefix: guessPrefix(p) })));
      })
      .catch((e) => setLoadErr(e.message));
  }, []);

  const selected = rows.filter((r) => r.selected);
  const setRow = (i: number, patch: Partial<ImportRow>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = useSubmit(async () => {
    if (!selected.length) throw new Error('Select at least one process');
    const name = appName.trim() || selected[0].proc.name.replace(/-(backend|frontend|api|web)$/i, '');
    const services = selected.map((r) => {
      const short = r.proc.name.replace(new RegExp(`^${slugify(name)}-?`), '') || r.proc.name;
      return {
        name: short,
        kind: 'process',
        cwd: r.proc.cwd,
        ...commandFor(r.proc),
        route: { pathPrefix: r.prefix || '/' },
      };
    });
    await api.post('/_api/apps', { name, services });
    if (stopOriginals) for (const r of selected) await api.post('/_api/pm2/stop', { name: r.proc.name });
  }, onClose);

  return (
    <Modal
      title="Import from pm2"
      onClose={onClose}
      wide
      footer={
        <Footer
          {...submit}
          onCancel={onClose}
          onSubmit={submit.run}
          label={`Import ${selected.length || ''} as one app`}
          extra={
            <label className="check" style={{ marginRight: 'auto' }}>
              <input type="checkbox" checked={stopOriginals} onChange={(e) => setStopOriginals(e.target.checked)} />
              Stop the original pm2 processes (they stay in <code>pm2 list</code>)
            </label>
          }
        />
      }
    >
      <div className="stack">
        <p className="note">
          Choose the processes that make up one site, such as its frontend and backend. Each one becomes a service mounted at the path you choose. Anything that has to keep running on a schedule (a cron job) should stay in plain pm2.
        </p>
        <label className="field">
          App name
          <input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder={selected[0]?.proc.name.replace(/-(backend|frontend|api|web)$/i, '') ?? 'time-tracker'} />
        </label>
        {loadErr && <p className="svc-err">{loadErr}</p>}
        {!procs && !loadErr && <p className="svc-sub">Loading pm2 processes…</p>}
        {procs && procs.length === 0 && <p className="svc-sub">No pm2 processes outside localserver.</p>}
        {procs && procs.length > 0 && (
          <table className="pm2">
            <thead>
              <tr>
                <th />
                <th>Process</th>
                <th>Command</th>
                <th>Port</th>
                <th>Mount at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.proc.name}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.selected}
                      disabled={Boolean(r.proc.cron)}
                      title={r.proc.cron ? 'Scheduled job: keep it in plain pm2' : undefined}
                      onChange={(e) => setRow(i, { selected: e.target.checked })}
                      aria-label={`Select ${r.proc.name}`}
                    />
                  </td>
                  <td>
                    <b>{r.proc.name}</b>
                    <div className="svc-sub">
                      {r.proc.cron ? `scheduled (${r.proc.cron}): keep in pm2` : `${r.proc.status} · ${fmtBytes(r.proc.memory)}`}
                    </div>
                  </td>
                  <td className="mono">
                    {r.proc.script.split('/').pop()} {r.proc.args.join(' ')}
                    <div className="svc-sub">{r.proc.cwd}</div>
                  </td>
                  <td className="mono">{r.proc.port ?? 'auto'}</td>
                  <td style={{ width: 110 }}>
                    <input className="mono" value={r.prefix} onChange={(e) => setRow(i, { prefix: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
