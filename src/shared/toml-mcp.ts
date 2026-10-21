import * as fs from 'node:fs/promises';
import { writeFileAtomic } from './atomic-file';

/**
 * Textual edits to `[mcp_servers.<name>]` tables in a Codex `config.toml`.
 * Codex's app-server refuses to write project config, and a TOML round-trip
 * would drop the user's comments, so only whole table blocks are touched.
 */

type TomlValue = string | string[] | Record<string, string>;

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return ''; }
    throw err;
  }
}

// JSON string escapes are a subset of TOML basic-string escapes.
const str = (s: string): string => JSON.stringify(s);

function render(value: TomlValue): string {
  if (typeof value === 'string') { return str(value); }
  if (Array.isArray(value)) { return `[${value.map(str).join(', ')}]`; }
  const pairs = Object.entries(value).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : str(k)} = ${str(v)}`);
  return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
}

function headerName(line: string): string | undefined {
  const m = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(\.[^\]]*)?\]\s*(#.*)?$/.exec(line);
  return m ? (m[1] ?? m[2]) : undefined;
}

const isHeader = (line: string): boolean => /^\s*\[/.test(line);

function refuseOtherShapes(file: string, lines: string[]): void {
  if (lines.some((l) => /^\s*mcp_servers\s*(=|\.)/.test(l) || /^\s*\[\s*mcp_servers\s*\]/.test(l))) {
    throw new Error(`Can't edit ${file}: it defines MCP servers in a form Marcode doesn't rewrite. Edit it by hand.`);
  }
}

export async function addTomlServer(file: string, name: string, fields: Record<string, TomlValue | undefined>): Promise<void> {
  const text = await readText(file);
  const lines = text.split(/\r?\n/);
  refuseOtherShapes(file, lines);
  if (lines.some((l) => headerName(l) === name)) { throw new Error(`A server named ${name} is already in ${file}.`); }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const isTable = (v: TomlValue): v is Record<string, string> => typeof v === 'object' && !Array.isArray(v);
  const entries = Object.entries(fields)
    .filter((e): e is [string, TomlValue] => e[1] !== undefined && !(isTable(e[1]) && Object.keys(e[1]).length === 0));
  const body = [...entries.filter(([, v]) => !isTable(v)), ...entries.filter(([, v]) => isTable(v))]
    .map(([k, v]) => `${k} = ${render(v)}`);
  const block = [`[mcp_servers.${name}]`, ...body].join(eol) + eol;
  const lead = text === '' ? '' : text.endsWith(eol) ? eol : eol + eol;
  await writeFileAtomic(file, text + lead + block);
}

/** `false` when no such table exists; the file is then left alone. */
export async function removeTomlServer(file: string, name: string): Promise<boolean> {
  const text = await readText(file);
  if (text === '') { return false; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  let found = false;
  for (const line of lines) {
    if (isHeader(line)) {
      skipping = headerName(line) === name;
      found ||= skipping;
    }
    if (!skipping) { kept.push(line); }
  }
  if (!found) { return false; }
  await writeFileAtomic(file, kept.join(eol));
  return true;
}
