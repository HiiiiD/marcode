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

const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const DOTTED = String.raw`${KEY}(?:\s*\.\s*${KEY})*`;
const HEADER_LINE = new RegExp(String.raw`^\s*(?:\[\s*${DOTTED}\s*\]|\[\[\s*${DOTTED}\s*\]\])\s*(?:#.*)?$`);
const KEY_START = new RegExp(String.raw`^\s*${DOTTED}\s*=`);

/**
 * A structural sanity check, not a parser: headers, `key =` lines, strings
 * (incl. multi-line) and bracket balance. Enough to refuse appending to a
 * file Codex would reject anyway. Returns the 1-based line of the first fault.
 */
export function invalidTomlLine(text: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const stack: string[] = [];
  let multi: '"""' | "'''" | undefined;
  let openedAt = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let i = 0;
    if (!multi && stack.length === 0) {
      if (/^\s*(#.*)?$/.test(line)) { continue; }
      if (isHeader(line)) {
        if (!HEADER_LINE.test(line)) { return n + 1; }
        continue;
      }
      const key = KEY_START.exec(line);
      if (!key) { return n + 1; }
      i = key[0].length;
    }
    while (i < line.length) {
      if (multi) {
        if (multi === '"""' && line[i] === '\\') { i += 2; continue; }
        if (line.startsWith(multi, i)) { multi = undefined; i += 3; continue; }
        i++;
        continue;
      }
      const c = line[i];
      if (c === '#') { break; }
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multi = line.slice(i, i + 3) as '"""' | "'''";
        openedAt = n + 1;
        i += 3;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) { j += c === '"' && line[j] === '\\' ? 2 : 1; }
        if (j >= line.length) { return n + 1; }
        i = j + 1;
        continue;
      }
      if (c === '[' || c === '{') {
        if (stack.length === 0) { openedAt = n + 1; }
        stack.push(c === '[' ? ']' : '}');
      } else if (c === ']' || c === '}') {
        if (stack.pop() !== c) { return n + 1; }
      }
      i++;
    }
  }
  return multi || stack.length > 0 ? openedAt : undefined;
}

function refuseOtherShapes(file: string, lines: string[]): void {
  if (lines.some((l) => /^\s*mcp_servers\s*(=|\.)/.test(l) || /^\s*\[\s*mcp_servers\s*\]/.test(l))) {
    throw new Error(`Can't edit ${file}: it defines MCP servers in a form Marcode doesn't rewrite. Edit it by hand.`);
  }
}

export async function addTomlServer(file: string, name: string, fields: Record<string, TomlValue | undefined>): Promise<void> {
  const text = await readText(file);
  const bad = invalidTomlLine(text);
  if (bad !== undefined) { throw new Error(`Can't edit ${file}: it isn't valid TOML (line ${bad}).`); }
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
  // Comments and blanks at the end of a removed block may introduce the next table instead.
  let held: string[] = [];
  for (const line of lines) {
    if (isHeader(line)) {
      const removing = headerName(line) === name;
      if (skipping && !removing) {
        const firstComment = held.findIndex((l) => l.trim() !== '');
        if (firstComment >= 0) { kept.push(...held.slice(firstComment)); }
      }
      held = [];
      skipping = removing;
      found ||= removing;
    }
    if (!skipping) { kept.push(line); } else if (/^\s*(#.*)?$/.test(line)) { held.push(line); } else { held = []; }
  }
  if (!found) { return false; }
  let out = kept.join(eol);
  if (text.endsWith(eol) && out !== '' && !out.endsWith(eol)) { out += eol; }
  await writeFileAtomic(file, out);
  return true;
}
