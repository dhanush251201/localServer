import { useState } from 'react';
import { api, fmtAgo, fmtBytes, fmtDuration, hostUrl, type App, type Route, type Service } from './api.ts';

export type Open =
  | { kind: 'editApp'; app: App }
  | { kind: 'addService'; app: App }
  | { kind: 'editService'; app: App; service: Service }
  | { kind: 'addRoute'; app: App }
  | { kind: 'editRoute'; app: App; route: Route }
  | { kind: 'logs'; service: Service }
  | { kind: 'build'; service: Service };

const STATE_LABEL: Record<string, string> = {
  ready: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Sleeping',
  error: 'Failed',
};

function StatePill({ svc }: { svc: Service }) {
  if (svc.kind === 'static') {
    return (
      <span className="pill static">
        <i /> Serving
      </span>
    );
  }
  const s = svc.runtime.state;
  return (
    <span className={`pill ${s}`}>
      <i /> {STATE_LABEL[s] ?? s}
    </span>
  );
}

function ServiceRow({ app, svc, now, open }: { app: App; svc: Service; now: number; open(o: Open): void }) {
  const [busy, setBusy] = useState('');
  const act = async (what: 'start' | 'stop' | 'restart') => {
    setBusy(what);
    try {
      await api.post(`/_api/services/${svc.id}/${what}`);
    } catch {
      // state stream shows the error
    } finally {
      setBusy('');
    }
  };
  const rt = svc.runtime;
  const isProc = svc.kind === 'process';
  const running = rt.state === 'ready';

  let meta: React.ReactNode;
  if (!isProc) {
    meta = (
      <span className="mono">
        {svc.distDir || '.'}
        {svc.spaFallback ? ' · SPA' : ''}
      </span>
    );
  } else if (running) {
    const idle = svc.effectiveIdleTimeoutSec;
    meta = (
      <>
        <b>{fmtBytes(rt.memory)}</b> · {rt.cpu}% cpu
        <br />
        {rt.sockets > 0
          ? `${rt.sockets} open connection${rt.sockets > 1 ? 's' : ''}`
          : idle === 0
            ? 'always on'
            : rt.idleStopAt
              ? `sleeps in ${fmtDuration(rt.idleStopAt - now)}`
              : 'handling requests'}
      </>
    );
  } else {
    meta = (
      <>
        last request {fmtAgo(rt.lastActivity, now)}
        <br />
        {rt.lastStartMs ? `cold start ${(rt.lastStartMs / 1000).toFixed(1)}s` : svc.effectiveIdleTimeoutSec === 0 ? 'always on' : `idle after ${fmtDuration(svc.effectiveIdleTimeoutSec * 1000)}`}
      </>
    );
  }

  return (
    <div className="svc">
      <div style={{ minWidth: 0 }}>
        <div className="svc-name">
          {svc.name} <span className="kind">{svc.kind === 'process' ? 'process' : 'static'}</span>
        </div>
        <div className="svc-sub mono" title={isProc ? `${svc.command} ${svc.args.join(' ')}` : svc.cwd}>
          {isProc ? `${svc.command.split('/').pop()} ${svc.args.join(' ')}` : svc.cwd.split('/').slice(-2).join('/')}
        </div>
      </div>
      <div>
        <StatePill svc={svc} />
        {isProc && (
          <div className="svc-sub mono" style={{ marginTop: 3 }}>
            :{svc.port ?? 'auto'}
            {rt.pid ? ` · pid ${rt.pid}` : ''}
          </div>
        )}
      </div>
      <div className="svc-meta">{meta}</div>
      <div className="svc-btns">
        {isProc &&
          (running ? (
            <>
              <button className="sm" disabled={!!busy} onClick={() => act('restart')}>
                {busy === 'restart' ? '…' : 'Restart'}
              </button>
              <button className="sm" disabled={!!busy} onClick={() => act('stop')}>
                {busy === 'stop' ? '…' : 'Stop'}
              </button>
            </>
          ) : (
            <button className="sm" disabled={!!busy || rt.state === 'starting'} onClick={() => act('start')}>
              {busy === 'start' || rt.state === 'starting' ? 'Starting…' : 'Start'}
            </button>
          ))}
        {svc.buildCommand && (
          <button className="sm" onClick={() => open({ kind: 'build', service: svc })}>
            {svc.build?.status === 'running' ? 'Building…' : svc.build?.status === 'failed' ? 'Build ✗' : 'Build'}
          </button>
        )}
        {isProc && (
          <button className="sm" onClick={() => open({ kind: 'logs', service: svc })}>
            Logs
          </button>
        )}
        <button className="sm ghost" onClick={() => open({ kind: 'editService', app, service: svc })}>
          Edit
        </button>
        <button
          className="sm ghost danger"
          onClick={() => confirm(`Delete service "${svc.name}"? Its pm2 process is removed too. Your project files aren't touched.`) && api.del(`/_api/services/${svc.id}`)}
          aria-label={`Delete ${svc.name}`}
        >
          ✕
        </button>
      </div>
      {rt.state === 'error' && rt.error && <div className="svc-err">{rt.error}</div>}
    </div>
  );
}

export function AppCard({ app, now, open }: { app: App; now: number; open(o: Open): void }) {
  const byId = new Map(app.services.map((s) => [s.id, s]));
  const routes = [...app.routes].sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0) || b.pathPrefix.length - a.pathPrefix.length);
  const primary = app.domains.find((d) => d.endsWith('.localhost')) ?? app.domains[0];

  return (
    <section className="card" aria-label={app.name}>
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h2>{app.name}</h2>
          <div className="domains">
            {app.domains.map((d) => (
              <a key={d} className="domain" href={hostUrl(d)} target="_blank" rel="noreferrer">
                {d}
              </a>
            ))}
            {app.domains.length === 0 && <span className="svc-sub">No domains yet</span>}
          </div>
        </div>
        <div className="card-actions">
          {primary && (
            <a className="btn sm" href={hostUrl(primary)} target="_blank" rel="noreferrer" style={{ padding: '5px 9px', fontSize: 12 }}>
              Open ↗
            </a>
          )}
          <button className="sm" onClick={() => open({ kind: 'addService', app })}>
            + Service
          </button>
          <button className="sm ghost" onClick={() => open({ kind: 'editApp', app })}>
            Edit
          </button>
          <button
            className="sm ghost danger"
            onClick={() => confirm(`Delete app "${app.name}" and its services? Your project files aren't touched.`) && api.del(`/_api/apps/${app.id}`)}
            aria-label={`Delete ${app.name}`}
          >
            ✕
          </button>
        </div>
      </div>

      {app.services.map((svc) => (
        <ServiceRow key={svc.id} app={app} svc={svc} now={now} open={open} />
      ))}
      {app.services.length === 0 && (
        <div className="svc">
          <span className="svc-sub">No services yet. Add a frontend or a backend.</span>
        </div>
      )}

      <div className="routes">
        <div className="routes-title">
          Routes
          <button className="sm ghost" style={{ marginLeft: 'auto' }} onClick={() => open({ kind: 'addRoute', app })} disabled={!app.services.length}>
            + Route
          </button>
        </div>
        {routes.map((r) => (
          <div className="route" key={r.id}>
            <code>
              {r.host || <span style={{ color: 'var(--faint)' }}>*</span>}
              {r.pathPrefix}
              {r.pathPrefix !== '/' ? '/*' : '*'}
            </code>
            <span className="arrow">→</span>
            <b>{byId.get(r.serviceId)?.name ?? '?'}</b>
            {r.stripPrefix && <span className="tag">strips prefix</span>}
            <button className="sm ghost" onClick={() => open({ kind: 'editRoute', app, route: r })}>
              Edit
            </button>
            <button className="sm ghost danger" onClick={() => api.del(`/_api/routes/${r.id}`)} aria-label="Delete route">
              ✕
            </button>
          </div>
        ))}
        {routes.length === 0 && <div className="svc-sub">Nothing is routed yet, so requests to this app's domains return 404.</div>}
      </div>
    </section>
  );
}
