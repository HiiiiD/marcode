import type { McpServerSpec } from '../../protocol/messages';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const stringMap = (v: unknown): Record<string, string> => {
  if (!isObject(v)) { return {}; }
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function looksLikeServer(v: Json): boolean {
  return (typeof v.url === 'string' || typeof v.command === 'string' || Array.isArray(v.command));
}

/** Claude/Codex style (`command`/`args`/`env`, `type`/`url`/`headers`) and OpenCode style (`local`/`remote`). */
function toSpec(name: string, raw: Json): McpServerSpec | undefined {
  if (typeof raw.url === 'string') {
    const transport = raw.type === 'sse' ? 'sse' : 'http';
    return { name, transport, url: raw.url, headers: stringMap(raw.headers ?? raw.http_headers) };
  }
  const [command, ...rest] = Array.isArray(raw.command) ? strings(raw.command) : [raw.command as string];
  if (typeof command !== 'string' || command === '') { return undefined; }
  const args = Array.isArray(raw.command) ? rest : strings(raw.args);
  const spec: McpServerSpec = { name, transport: 'stdio', command, args, env: stringMap(raw.env ?? raw.environment) };
  if (typeof raw.cwd === 'string' && raw.cwd !== '') { spec.cwd = raw.cwd; }
  return spec;
}

/** A README-style snippet → one server spec. A bare server object leaves `name` blank. */
export function parseMcpSnippet(text: string): { server: McpServerSpec } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "That isn't valid JSON." };
  }
  if (!isObject(parsed)) { return { error: 'Paste a JSON object describing one server.' }; }

  let entries: [string, unknown][];
  if (looksLikeServer(parsed)) {
    entries = [['', parsed]];
  } else {
    const container = isObject(parsed.mcpServers) ? parsed.mcpServers : isObject(parsed.mcp) ? parsed.mcp : parsed;
    entries = Object.entries(container);
  }
  if (entries.length === 0) { return { error: 'No server found in that JSON.' }; }
  if (entries.length > 1) {
    return { error: `Found ${entries.length} servers (${entries.map(([n]) => n).join(', ')}). Paste one at a time.` };
  }
  const [name, raw] = entries[0];
  const spec = isObject(raw) ? toSpec(name, raw) : undefined;
  return spec ? { server: spec } : { error: 'That server has neither a command nor a url.' };
}
