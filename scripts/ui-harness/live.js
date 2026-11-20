const q = new URLSearchParams(location.search);
document.documentElement.className = document.body.className = `vscode-${q.get('theme') ?? 'dark'}`;
if (q.get('w')) document.getElementById('root').style.width = `${q.get('w')}px`;

const posted = (window.__posted = []);
const events = new EventSource('/events');
events.onmessage = (e) => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
await new Promise((resolve) => { events.onopen = resolve; });

window.__post = (msg) => fetch('/post', { method: 'POST', body: JSON.stringify(msg) });
window.acquireVsCodeApi = () => ({
  postMessage(msg) { posted.push(msg); window.__post(msg); },
  getState: () => undefined,
  setState() {},
});

await import('/dist/webview.js');
