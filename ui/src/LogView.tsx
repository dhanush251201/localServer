import { useEffect, useRef, useState } from 'react';
import { api, type Service } from './api.ts';
import { Modal } from './Modal.tsx';
import { buildBus } from './useGateway.ts';

type Line = { stream: string; text: string };

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

export function LogsModal({ service, onClose }: { service: Service; onClose(): void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const scroll = useAutoScroll(lines);

  useEffect(() => {
    const es = new EventSource(`/_api/services/${service.id}/logs`);
    es.onmessage = (e) => {
      const l = JSON.parse(e.data) as Line;
      setLines((cur) => [...cur, l].slice(-2000));
    };
    return () => es.close();
  }, [service.id]);

  return (
    <Modal title={`Logs · ${service.pm2Name}`} onClose={onClose} wide>
      <div className="term" ref={scroll.ref} onScroll={scroll.onScroll}>
        {lines.length === 0 && <span style={{ opacity: 0.6 }}>No output yet. Logs appear here once the service starts.</span>}
        {lines.map((l, i) => (
          <span key={i} className={l.stream === 'err' ? 'e' : undefined}>
            {l.text}
          </span>
        ))}
      </div>
    </Modal>
  );
}

export function BuildModal({ service, onClose }: { service: Service; onClose(): void }) {
  const [output, setOutput] = useState('');
  const scroll = useAutoScroll(output);

  useEffect(() => {
    let alive = true;
    api.get<{ output: string } | null>(`/_api/services/${service.id}/build`).then((j) => alive && setOutput(j?.output ?? ''));
    const off = buildBus.on(service.id, (chunk) => setOutput((o) => o + chunk));
    return () => {
      alive = false;
      off();
    };
  }, [service.id]);

  const running = service.build?.status === 'running';
  return (
    <Modal
      title={`Build · ${service.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="svc-sub" style={{ marginRight: 'auto' }}>
            <code>{service.buildCommand}</code>
          </span>
          <button
            className="primary"
            disabled={running}
            onClick={() => {
              setOutput('');
              api.post(`/_api/services/${service.id}/build`).catch((e) => setOutput(String(e.message)));
            }}
          >
            {running ? 'Building…' : 'Run build'}
          </button>
        </>
      }
    >
      <div className="term" ref={scroll.ref} onScroll={scroll.onScroll}>
        {output || <span style={{ opacity: 0.6 }}>No build has run yet.</span>}
      </div>
    </Modal>
  );
}
