// Channel between the offscreen document (which owns the session) and the views
// (side panel, dashboard). All extension pages share an origin, so a BroadcastChannel
// reaches every open view and carries typed arrays without JSON encoding.

export const CHANNEL = 'streammon';

// handlers: { snapshot, session, frame, row, log, alerts, spectrum } -> fn(message)
export function connectHub(handlers) {
  const ch = new BroadcastChannel(CHANNEL);
  const pending = new Map();
  let nextId = 1;
  ch.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'reply') {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      if (resolve) resolve(m);
    } else if (handlers[m.type]) {
      handlers[m.type](m);
    }
  };
  ch.postMessage({ type: 'hello' });
  return {
    send: (msg) => ch.postMessage(msg),
    hello: () => ch.postMessage({ type: 'hello' }),
    request: (type) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        ch.postMessage({ type, id });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error('The monitor is not running. Click the toolbar button on a YouTube tab first.'));
        }, 3000);
      }),
  };
}
