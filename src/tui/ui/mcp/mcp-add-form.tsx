import { useKeyboard } from '@opentui/react';
import { parseMcpSnippet } from '../../../client-core/mcp/parse-snippet';
import { splitCommandLine } from '../../../client-core/mcp/split-command';
import { validateSpec } from '../../../client-core/mcp/validate-spec';
import type { McpCapabilities, McpScope, McpServerSpec, McpTarget } from '../../../protocol/messages';
import { Dialog } from '../termcn/components/ui/dialog';
import { useSyncState } from '../use-sync-state';

type Kind = 'stdio' | 'http' | 'sse' | 'json';
type FieldId = 'type' | 'name' | 'command' | 'cwd' | 'env' | 'url' | 'headers' | 'json' | 'scope';
type Form = Record<'name' | 'command' | 'cwd' | 'env' | 'url' | 'headers' | 'json', string> & {
  kind: Kind; scope: McpScope; focus: number; error?: string;
};

const KIND_LABEL: Record<Kind, string> = { stdio: 'stdio', http: 'HTTP', sse: 'SSE', json: 'Paste JSON' };
const FIELD_LABEL: Record<FieldId, string> = {
  type: 'Type', name: 'Name', command: 'Command', cwd: 'Working directory', env: 'Env (K=V …)',
  url: 'URL', headers: 'Headers (K=V …)', json: 'JSON', scope: 'Save to',
};

function fieldsFor(kind: Kind, caps: McpCapabilities): FieldId[] {
  if (kind === 'json') { return ['type', 'json']; }
  if (kind === 'stdio') { return ['type', 'name', 'command', ...(caps.workingDirectory ? ['cwd' as const] : []), 'env', 'scope']; }
  return ['type', 'name', 'url', 'headers', 'scope'];
}

/** `K=V A="b c"` → a record; a token with no `=` is ignored. */
function pairs(line: string): Record<string, string> {
  const split = splitCommandLine(line);
  if ('error' in split) { return {}; }
  return Object.fromEntries([split.command, ...split.args].flatMap((tok) => {
    const at = tok.indexOf('=');
    return at > 0 ? [[tok.slice(0, at), tok.slice(at + 1)]] : [];
  }));
}

const unpairs = (r: Record<string, string>): string => Object.entries(r).map(([k, v]) => (/\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`)).join(' ');

export function McpAddForm({ capabilities, targets, error, onSubmit, onBack }: {
  capabilities: McpCapabilities;
  targets: Record<McpScope, McpTarget> | null;
  error?: string;
  onSubmit(scope: McpScope, server: McpServerSpec): void;
  onBack(): void;
}) {
  const kinds: Kind[] = ['stdio', 'http', ...(capabilities.sse ? ['sse' as const] : []), 'json'];
  const usable = (s: McpScope) => !targets || 'path' in targets[s];
  const st = useSyncState<Form>({
    kind: 'stdio', scope: usable('repo') ? 'repo' : 'global', focus: 0,
    name: '', command: '', cwd: '', env: '', url: '', headers: '', json: '',
  });

  const submit = (f: Form) => {
    if (f.kind === 'json') {
      const parsed = parseMcpSnippet(f.json);
      if ('error' in parsed) { st.set({ error: parsed.error }); return; }
      const s = parsed.server;
      st.set(s.transport === 'stdio'
        ? { kind: 'stdio', focus: 1, error: undefined, name: s.name || f.name, command: [s.command, ...s.args].join(' '), env: unpairs(s.env), cwd: s.cwd ?? '' }
        : { kind: s.transport === 'sse' && capabilities.sse ? 'sse' : 'http', focus: 1, error: undefined, name: s.name || f.name, url: s.url, headers: unpairs(s.headers) });
      return;
    }
    let spec: McpServerSpec;
    if (f.kind === 'stdio') {
      const split = splitCommandLine(f.command);
      if ('error' in split) { st.set({ error: split.error }); return; }
      spec = { name: f.name.trim(), transport: 'stdio', command: split.command, args: split.args, env: pairs(f.env) };
      if (capabilities.workingDirectory && f.cwd.trim()) { spec.cwd = f.cwd.trim(); }
    } else {
      spec = { name: f.name.trim(), transport: f.kind, url: f.url.trim(), headers: pairs(f.headers) };
    }
    const invalid = validateSpec(spec, []);
    if (invalid) { st.set({ error: invalid }); return; }
    onSubmit(f.scope, spec);
  };

  useKeyboard((key) => {
    const f = st.get();
    const fields = fieldsFor(f.kind, capabilities);
    const field = fields[Math.min(f.focus, fields.length - 1)];
    if (key.name === 'escape') { onBack(); return; }
    if (key.name === 'return') { submit(f); return; }
    if ((key.name === 'tab' && !key.shift) || key.name === 'down') { st.set({ focus: Math.min(fields.length - 1, f.focus + 1) }); return; }
    if ((key.name === 'tab' && key.shift) || key.name === 'up') { st.set({ focus: Math.max(0, f.focus - 1) }); return; }
    if (field === 'type' && (key.name === 'left' || key.name === 'right')) {
      const i = kinds.indexOf(f.kind) + (key.name === 'right' ? 1 : -1);
      st.set({ kind: kinds[(i + kinds.length) % kinds.length], error: undefined });
      return;
    }
    if (field === 'scope' && (key.name === 'left' || key.name === 'right')) {
      const other: McpScope = f.scope === 'repo' ? 'global' : 'repo';
      if (usable(other)) { st.set({ scope: other }); }
      return;
    }
    if (field === 'type' || field === 'scope') { return; }
    if (key.name === 'backspace') { st.set({ [field]: f[field].slice(0, -1) } as Partial<Form>); return; }
    if (!key.ctrl && !key.meta && key.sequence.length >= 1 && key.sequence >= ' ' && !key.sequence.includes('\u001b')) {
      st.set({ [field]: f[field] + key.sequence, error: undefined } as Partial<Form>);
    }
  });

  const f = st.view;
  const fields = fieldsFor(f.kind, capabilities);
  const target = targets?.[f.scope];
  const valueOf = (id: FieldId): string => {
    if (id === 'type') { return kinds.map((k) => (k === f.kind ? `[${KIND_LABEL[k]}]` : KIND_LABEL[k])).join(' '); }
    if (id === 'scope') { return (['repo', 'global'] as const).map((s) => (s === f.scope ? `[${s === 'repo' ? 'Repo' : 'Global'}]` : s === 'repo' ? 'Repo' : 'Global')).join(' '); }
    return f[id];
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Add MCP server">
        {fields.map((id, i) => (
          <text key={id} attributes={i === f.focus ? 1 : 0}>
            <span>{i === f.focus ? '› ' : '  '}</span>
            <span fg="gray">{`${FIELD_LABEL[id]}: `}</span>
            <span>{`${valueOf(id)}${i === f.focus && id !== 'type' && id !== 'scope' ? '▏' : ''}`}</span>
          </text>
        ))}
        {f.kind === 'stdio' && !capabilities.workingDirectory
          ? <text fg="gray">Claude can&apos;t set a working directory — use the tool&apos;s own flag, e.g. uv --directory.</text>
          : null}
        {f.kind !== 'json' && target ? (
          <text fg="gray">{'path' in target ? `Writes ${target.path} · restart needed` : target.unavailable}</text>
        ) : null}
        {f.kind !== 'json' && target && 'path' in target && target.note ? <text fg="gray">{target.note}</text> : null}
        {f.error ?? error ? <text fg="red">{f.error ?? error}</text> : null}
        <text fg="gray">Tab next · ←→ choose · Enter {f.kind === 'json' ? 'use this' : 'add'} · Esc back</text>
      </Dialog>
    </box>
  );
}
