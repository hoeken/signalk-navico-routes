/**
 * Minimal client for the Freeboard-SK Plotter Extensions message bus:
 * JSON-RPC 2.0 inside `{ bus: 'plotterExt/1', msg }` envelopes, exchanged
 * with the parent frame over postMessage (docs/api/plotter-extensions-api.md,
 * "Communication"). Only what the send window needs: the handshake, calls
 * and event subscriptions.
 */

const BUS = 'plotterExt/1';

export interface Handshake {
  capabilities?: string[];
  context?: { kind?: string; invocation?: unknown };
}

export interface BusClient {
  handshake: Handshake;
  has(capability: string): boolean;
  call(method: string, params?: unknown): Promise<unknown>;
  /** Subscribes to exact event names (no wildcards). */
  subscribe(events: string[], listener: (event: string, params: unknown) => void): Promise<void>;
}

interface RpcMessage {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

/** Announces itself to the host until it answers with the handshake. */
export function connectBus(timeoutMs = 15000): Promise<BusClient> {
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(err: Error): void; timer: number }
  >();
  const listeners: { events: string[]; listener: (event: string, params: unknown) => void }[] = [];
  let seq = 0;

  const post = (msg: object) =>
    window.parent.postMessage({ bus: BUS, msg: { jsonrpc: '2.0', ...msg } }, location.origin);

  return new Promise((resolve, reject) => {
    let client: BusClient | undefined;
    const ready = window.setInterval(() => post({ method: 'bus.ready' }), 250);
    const giveUp = window.setTimeout(() => {
      window.clearInterval(ready);
      reject(new Error('no Plotter Extensions host answered'));
    }, timeoutMs);
    post({ method: 'bus.ready' });

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { bus?: unknown; msg?: RpcMessage } | null;
      if (event.source !== window.parent || !data || data.bus !== BUS || !data.msg) {
        return;
      }
      const msg = data.msg;
      if (msg.method === 'bus.handshake') {
        if (!client) {
          window.clearInterval(ready);
          window.clearTimeout(giveUp);
          client = makeClient(msg.params ?? {});
          resolve(client);
        }
        return;
      }
      if (msg.id !== undefined) {
        const call = pending.get(msg.id);
        if (call) {
          pending.delete(msg.id);
          window.clearTimeout(call.timer);
          if (msg.error) {
            call.reject(new Error(msg.error.message || 'host error'));
          } else {
            call.resolve(msg.result);
          }
        }
        return;
      }
      if (msg.method) {
        for (const l of listeners) {
          if (l.events.indexOf(msg.method) >= 0) {
            l.listener(msg.method, msg.params);
          }
        }
      }
    });
  });

  function makeClient(handshake: Handshake): BusClient {
    const call = (method: string, params?: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = 'navico-' + ++seq;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(method + ': no answer from host'));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        post({ id, method, params });
      });
    return {
      handshake,
      has: (capability) =>
        Array.isArray(handshake.capabilities) && handshake.capabilities.indexOf(capability) >= 0,
      call,
      subscribe: async (events, listener) => {
        listeners.push({ events, listener });
        await call('events.subscribe', { patterns: events });
      },
    };
  }
}
