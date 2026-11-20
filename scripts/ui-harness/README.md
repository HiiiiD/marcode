# UI harness

Screenshot and DOM checks of the real webview bundle in a plain browser, outside VS Code. Build the bundle first: `node esbuild.js`.

## Fixture mode (static replay of your real sessions)

```
node scripts/ui-harness/build-fixture.mjs      # reads the current workspace's sessions into .ui-harness/fixture.json
node scripts/ui-harness/serve.mjs 4173         # http://127.0.0.1:4173/?theme=dark&w=960&open=<ids>&o=vertical|horizontal
node scripts/ui-harness/serve.mjs 4174 <distDir>   # same page against another build, for before/after
```

`window.__send(msg)` injects a host message; `window.__posted` lists what the webview sent.

## Live mode (a real host, scripted agent)

```
npx tsx scripts/ui-harness/live-bridge.ts 4175   # http://127.0.0.1:4175/live?theme=dark
```

Boots the same `createHost` the daemon runs, in a throwaway `MARCODE_HOME`, with the scripted `FakeProvider`, and
bridges it to the page (`POST /post`, server-sent `/events`). Nothing from your real workspace or account is used.
Create a session with `window.__post({ t: 'create-session', providerId: 'fake', cwd: '', model: 'fake-large', effort: 'medium', mode: 'default' })`,
then `window.__post({ t: 'send', id, text })`. Put `scenario:<name>` in the prompt:

| name | what it plays |
|---|---|
| `slow` | thinking gap, a 4s Bash call, another gap, streamed text |
| `quiet` | a 65s silence, then an answer (shows the quiet clock) |
| `permission` | a pending `git push --force` approval |
| `error` | the provider fails mid-turn |

Any other prompt answers "ok" at once. Stop and Allow/Deny work as in the real panel.
