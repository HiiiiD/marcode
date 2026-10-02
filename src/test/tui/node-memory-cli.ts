import { FtsMemoryStore } from '../../memory/fts-memory-store';

const [command, file, query] = process.argv.slice(2);

async function main(): Promise<void> {
  const store = new FtsMemoryStore(file, { tail: async () => ({ items: [], hasMore: false }) });
  if (command === 'write') {
    await store.index({
      sessionId: 'from-node', providerId: 'claude', cwd: '/repo', closedAt: 1,
      items: [{ id: 'n1', ts: 0, role: 'user', text: 'zebra migration plan' }],
    });
  } else if (command === 'search') {
    console.log(JSON.stringify((await store.search(query ?? '')).map((hit) => hit.sessionId)));
  }
  store.close();
}

void main();
