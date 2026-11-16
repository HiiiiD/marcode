// Static server: /dist/*, /fixture.json, /theme.css, and the harness page at /.
// Usage: node scripts/ui-harness/serve.mjs [port]   Page: /?theme=dark|light&w=400&open=idA,idB&o=vertical|horizontal
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 4173);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' };
const harnessDir = fileURLToPath(new URL('.', import.meta.url));
const route = (p) => {
  if (p === '/') return join(harnessDir, 'page.html');
  if (p === '/theme.css' || p === '/page.js') return join(harnessDir, p.slice(1));
  if (p === '/fixture.json') return '.ui-harness/fixture.json';
  if (p.startsWith('/dist/')) return join('dist', normalize(p.slice(6)).replace(/^(\.\.[\\/])+/, ''));
  return null;
};

createServer(async (req, res) => {
  const file = route(new URL(req.url, 'http://x').pathname);
  if (!file) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'text/plain', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`harness http://127.0.0.1:${port}/`));
