// `@agentclientprotocol/sdk` ships `"type": "module"` (ESM-only, `main:
// "dist/acp.js"`). This extension host bundle is CJS (esbuild `format:
// 'cjs'`), so the runtime `ClientSideConnection` class and `ndJsonStream`
// function must be reached via a dynamic `import()` — a static `import {
// ClientSideConnection, ndJsonStream } from '...'` fails TypeScript
// compilation with TS1479 ("referenced file is an ECMAScript module and
// cannot be imported with 'require'"). Types are imported separately with
// `import type ... with { 'resolution-mode': 'import' }`, which resolves the
// `.d.ts` without requiring a CJS/ESM interop shim. Same pattern as
// `loadQuery` in `src/providers/claude/claude-provider.ts`. This is why
// `connectAcp` is async where the task brief's sketch had it synchronous.
import { Readable, Writable } from 'node:stream';
import type { ClientSideConnection, Client } from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };

/**
 * The child process, narrowed to what this module uses, so tests inject a
 * pair of PassThroughs instead of spawning a binary. Mirrors `Duplex` in
 * `src/providers/codex/app-server.ts`.
 */
export interface AcpChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  kill(): void;
  onFailure?(cb: (reason: string) => void): void;
}

/**
 * We advertise no filesystem and no terminal. OpenCode calls
 * `fs/write_text_file` regardless, takes the method-not-found, and falls back
 * to its own IO — measured on 1.18.18 — so refusing costs nothing and keeps
 * the host out of the file-writing business. That also keeps fleet-diff
 * attribution reading the transcript rather than our own writes.
 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export const PROTOCOL_VERSION = 1;

export interface AcpHandlers {
  sessionUpdate(params: unknown): void;
  requestPermission(params: unknown): Promise<unknown>;
}

/**
 * Node streams to Web streams, which is what `ndJsonStream` takes. `Readable`
 * and `Writable` both expose `toWeb` in Node 22. Cast through `unknown`:
 * `@types/node`'s `ReadableStream`/`WritableStream` generics and the DOM
 * lib's (both in scope per `tsconfig.json`) disagree on the exact shape of
 * `ArrayBufferView`, which is a typings mismatch, not a runtime one — the
 * objects `toWeb` returns are genuine Web Streams either way.
 *
 * `readTextFile` / `writeTextFile` / the terminal methods are deliberately
 * absent from the returned `Client`: they are optional on the SDK's `Client`
 * interface, and an absent handler is what produces the method-not-found a
 * client that advertised those capabilities as `false` is expected to give.
 */
export async function connectAcp(child: AcpChild, handlers: AcpHandlers): Promise<ClientSideConnection> {
  const { ClientSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');

  const input = Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin as Writable) as unknown as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const toClient = (): Client => ({
    sessionUpdate: (params) => { handlers.sessionUpdate(params); },
    requestPermission: (params) => handlers.requestPermission(params) as never,
  });

  return new ClientSideConnection(toClient, stream);
}
