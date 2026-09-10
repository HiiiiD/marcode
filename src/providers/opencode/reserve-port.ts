import { createServer } from 'node:net';

/**
 * Binds to an OS-assigned free port on loopback, reads it back, closes
 * immediately. `opencode acp` binds the real port itself (see
 * `opencode-provider.ts`) — this only reserves a number to hand it via
 * `--port`, since ACP mode never prints which port it chose. Inherently
 * racy (something else could claim the port between close and opencode's
 * own bind) — `opencode-provider.ts` retries the whole spawn on failure,
 * which is the actual safety net.
 */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (port) { resolve(port); } else { reject(new Error('no port assigned')); }
      });
    });
  });
}
