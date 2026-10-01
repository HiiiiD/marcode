# Bun host spike, 2026-10-01

Bun 1.3.5 (Windows x64), @opentui/core 0.5.13, @opentui/react 0.5.13.

| Probe | Result |
|---|---|
| runtime | ok 1.3.5 |
| node:sqlite fts5 | FAIL No such built-in module: node:sqlite |
| acp sdk (esm import) | ok |
| opencode sdk | ok |
| claude agent sdk | ok |
| createHost fake, memory=true | FAIL No such built-in module: node:sqlite |
| createHost fake, memory=false | FAIL No such built-in module: node:sqlite |

Result above is before the fix. Cause: `src/memory/fts-memory-store.ts` statically imports
`node:sqlite`, and `create-host.ts` imported it at module load, so the failure preceded the memory flag.

Fix: `create-host.ts` now loads `FtsMemoryStore` with a lazy `require` inside the existing
`if (config.memory.enabled) { try ... }` block (type-only import at the top), so a missing
`node:sqlite` falls into the "memory store unavailable" catch. `require` rather than `import()`
because `tsx/cjs` runs a native `import()` that cannot resolve the extensionless `.ts` path, and
Node16 type-checking demands an extension on `import()`. After the fix, under Bun without any stub:
both createHost probes are `ok turn streamed` (memory=true warns and runs with memory off); only
`node:sqlite fts5` stays FAIL.

Decision: TUI memory = off (forced). Task 6's `bootHost` sets `memory.enabled = false` when
`process.versions.bun` is defined.
