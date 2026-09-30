import { useState } from 'react';
import { fmtBytes, type App as AppT } from './api.ts';
import { useGateway } from './useGateway.ts';
import { AppCard, type Open } from './AppCard.tsx';
import { AppForm, ImportDialog, RouteForm, ServiceForm, SettingsForm } from './forms.tsx';
import { BuildModal, LogsModal } from './LogView.tsx';

type Dialog = Open | { kind: 'newApp' } | { kind: 'import' } | { kind: 'settings' } | null;

export function App() {
  const { state, connected, now } = useGateway();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  // Dialogs hold a snapshot; look up the live copy so status/buttons stay current.
  const liveApp = (a: AppT) => state?.apps.find((x) => x.id === a.id) ?? a;
  const liveService = (id: number) => state?.apps.flatMap((a) => a.services).find((s) => s.id === id);

  const services = state?.apps.flatMap((a) => a.services) ?? [];
  const procs = services.filter((s) => s.kind === 'process');
  const running = procs.filter((s) => s.runtime.state === 'ready');
  const memory = running.reduce((n, s) => n + s.runtime.memory, 0);

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <span />
            <span />
          </span>
          localserver
        </div>
        <span className={`conn${connected ? '' : ' off'}`}>
          <i /> {connected ? `gateway on :${state?.settings.listenPort}` : 'reconnecting…'}
          {state?.settings.lanEnabled && state.lanIp ? ` · LAN ${state.lanIp}` : ''}
        </span>
        <span className="spacer" />
        <button onClick={() => setDialog({ kind: 'import' })}>Import from pm2</button>
        <button onClick={() => setDialog({ kind: 'settings' })} disabled={!state}>
          Settings
        </button>
        <button className="primary" onClick={() => setDialog({ kind: 'newApp' })}>
          + New app
        </button>
      </header>

      {state && (
        <div className="summary">
          <div className="stat">
            <div className="v">{state.apps.length}</div>
            <div className="l">apps</div>
          </div>
          <div className="stat">
            <div className="v">
              {running.length}
              <span style={{ color: 'var(--faint)', fontWeight: 400 }}> / {procs.length}</span>
            </div>
            <div className="l">processes running</div>
          </div>
          <div className="stat">
            <div className="v">{fmtBytes(memory)}</div>
            <div className="l">memory in use</div>
          </div>
          <div className="stat">
            <div className="v">{Math.round(state.settings.defaultIdleTimeoutSec / 60)} min</div>
            <div className="l">default idle timeout</div>
          </div>
        </div>
      )}

      {!state && <p className="svc-sub">Connecting to gateway…</p>}

      {state && state.apps.length === 0 && (
        <div className="empty">
          <h3>No apps yet</h3>
          <p>Add an app, give it a domain, then attach a static frontend or a backend process.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
            <button onClick={() => setDialog({ kind: 'import' })}>Import from pm2</button>
            <button className="primary" onClick={() => setDialog({ kind: 'newApp' })}>
              + New app
            </button>
          </div>
        </div>
      )}

      <div className="apps">
        {state?.apps.map((app) => (
          <AppCard key={app.id} app={app} now={now} open={setDialog} />
        ))}
      </div>

      {dialog?.kind === 'newApp' && <AppForm onClose={close} />}
      {dialog?.kind === 'editApp' && <AppForm app={liveApp(dialog.app)} onClose={close} />}
      {dialog?.kind === 'addService' && <ServiceForm app={liveApp(dialog.app)} onClose={close} />}
      {dialog?.kind === 'editService' && <ServiceForm app={liveApp(dialog.app)} service={dialog.service} onClose={close} />}
      {dialog?.kind === 'addRoute' && <RouteForm app={liveApp(dialog.app)} onClose={close} />}
      {dialog?.kind === 'editRoute' && <RouteForm app={liveApp(dialog.app)} route={dialog.route} onClose={close} />}
      {dialog?.kind === 'logs' && <LogsModal service={liveService(dialog.service.id) ?? dialog.service} onClose={close} />}
      {dialog?.kind === 'build' && <BuildModal service={liveService(dialog.service.id) ?? dialog.service} onClose={close} />}
      {dialog?.kind === 'import' && <ImportDialog onClose={close} />}
      {dialog?.kind === 'settings' && state && <SettingsForm state={state} onClose={close} />}
    </div>
  );
}
