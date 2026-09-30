import { useEffect, useState } from 'react';
import type { GatewayState } from './api.ts';

type Listener = (chunk: string) => void;

/** Fan-out for build output chunks arriving on the shared event stream. */
export const buildBus = {
  listeners: new Map<number, Set<Listener>>(),
  on(serviceId: number, fn: Listener) {
    const set = this.listeners.get(serviceId) ?? new Set();
    set.add(fn);
    this.listeners.set(serviceId, set);
    return () => set.delete(fn);
  },
  emit(serviceId: number, chunk: string) {
    this.listeners.get(serviceId)?.forEach((fn) => fn(chunk));
  },
};

/** Live gateway state over SSE. EventSource reconnects on its own if the gateway restarts. */
export function useGateway() {
  const [state, setState] = useState<GatewayState | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Server timestamps drive idle countdowns; correct for clock skew (e.g. viewing from a phone).
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const es = new EventSource('/_api/events');
    es.addEventListener('state', (e) => {
      const next = JSON.parse((e as MessageEvent).data) as GatewayState;
      setOffset(next.now - Date.now());
      setState(next);
      setConnected(true);
    });
    es.addEventListener('build', (e) => {
      const { serviceId, chunk } = JSON.parse((e as MessageEvent).data);
      buildBus.emit(serviceId, chunk);
    });
    es.onerror = () => setConnected(false);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, []);

  return { state, connected, now: now + offset };
}
