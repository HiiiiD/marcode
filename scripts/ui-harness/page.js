const q = new URLSearchParams(location.search);
document.documentElement.className = document.body.className = `vscode-${q.get('theme') ?? 'dark'}`;
if (q.get('w')) document.getElementById('root').style.width = `${q.get('w')}px`;

const fx = await (await fetch('/fixture.json')).json();
const open = (q.get('open') ?? Object.keys(fx.snapshots).slice(-2).join(',')).split(',').filter(Boolean);
const posted = (window.__posted = []);
const send = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
window.__send = send;

function hydrate() {
  const leaf = (id) => ({ kind: 'leaf', sessionId: id, size: 100 / open.length });
  send({
    t: 'hydrate',
    sessions: fx.sessions.map((s) => ({ ...s, open: open.includes(s.id) })),
    layout: {
      root: { kind: 'split', orientation: q.get('o') ?? 'vertical', size: 100, children: open.map(leaf) },
      presets: [], focusedSessionId: open[0] ?? null,
    },
    snapshots: open.map((id) => fx.snapshots[id]),
    catalog: fx.catalog, unavailable: [], probing: false, usage: fx.usage,
    showCacheTimer: false, favoriteModels: [],
  });
}

window.acquireVsCodeApi = () => ({
  postMessage(msg) { posted.push(msg); if (msg.t === 'ready') hydrate(); },
  getState: () => undefined,
  setState() {},
});

await import('/dist/webview.js');
