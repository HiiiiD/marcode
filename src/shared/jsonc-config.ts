import * as fs from 'node:fs/promises';
import { findNodeAtLocation, parse, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { writeFileAtomic } from './atomic-file';

type KeyPath = string[];

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
    throw err;
  }
}

function parseOrThrow(file: string, text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const line = text.slice(0, errors[0].offset).split('\n').length;
    throw new Error(`Can't edit ${file}: it isn't valid JSON (line ${line}).`);
  }
  return value;
}

interface Style { unit: string; eol: string }

function styleOf(text: string): Style {
  return { unit: /\n([ \t]+)"/.exec(text)?.[1] ?? '  ', eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

function render(value: unknown, indent: string, style: Style): string {
  return JSON.stringify(value, null, style.unit).split('\n').join(style.eol + indent);
}

/**
 * Inserts or replaces one member. jsonc-parser's own formatter re-flows the
 * whole enclosing object, so siblings are spliced around by hand instead.
 */
function setEdit(text: string, keyPath: KeyPath, value: unknown, style: Style): string {
  const root = parseTree(text);
  if (!root || root.type !== 'object') { return render(nest(keyPath, value), '', style) + style.eol; }
  const existing = findNodeAtLocation(root, keyPath);
  if (existing) {
    const indent = lineIndent(text, existing.parent!.offset);
    return splice(text, existing.offset, existing.length, render(value, indent, style));
  }
  let depth = keyPath.length - 1;
  let parent: JsonNode | undefined;
  while (depth > 0 && !(parent = findNodeAtLocation(root, keyPath.slice(0, depth)))) { depth--; }
  if (depth === 0) { parent = root; }
  if (!parent || parent.type !== 'object') { throw new Error(`Can't add ${keyPath.join('.')}: ${keyPath.slice(0, depth).join('.')} isn't an object.`); }
  const key = keyPath[depth];
  const child = nest(keyPath.slice(depth + 1), value);
  const parentIndent = lineIndent(text, parent.parent ? parent.parent.offset : parent.offset);
  const indent = parentIndent + style.unit;
  const member = `${JSON.stringify(key)}: ${render(child, indent, style)}`;
  const kids = parent.children ?? [];
  if (kids.length > 0) {
    const last = kids[kids.length - 1];
    return splice(text, last.offset + last.length, 0, `,${style.eol}${indent}${member}`);
  }
  return splice(text, parent.offset, parent.length, `{${style.eol}${indent}${member}${style.eol}${parentIndent}}`);
}

function removeEdit(text: string, keyPath: KeyPath): string {
  const root = parseTree(text)!;
  const prop = findNodeAtLocation(root, keyPath)!.parent!;
  const siblings = prop.parent!.children!;
  const i = siblings.indexOf(prop);
  if (i > 0) {
    const prev = siblings[i - 1];
    return splice(text, prev.offset + prev.length, prop.offset + prop.length - (prev.offset + prev.length), '');
  }
  if (siblings.length > 1) { return splice(text, prop.offset, siblings[1].offset - prop.offset, ''); }
  const obj = prop.parent!;
  return splice(text, obj.offset, obj.length, '{}');
}

function nest(keys: KeyPath, value: unknown): unknown {
  return keys.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

function splice(text: string, offset: number, length: number, content: string): string {
  return text.slice(0, offset) + content + text.slice(offset + length);
}

function memberAt(value: unknown, keyPath: KeyPath): unknown {
  let node = value;
  for (const key of keyPath) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) { return undefined; }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Sets one member, leaving comments and every other byte of the file alone. */
export async function setJsonMember(file: string, keyPath: KeyPath, value: unknown): Promise<void> {
  const text = await readText(file);
  if (text === undefined || text.trim() === '') {
    await writeFileAtomic(file, render(nest(keyPath, value), '', styleOf('')) + '\n');
    return;
  }
  parseOrThrow(file, text);
  await writeFileAtomic(file, setEdit(text, keyPath, value, styleOf(text)));
}

/** `false` when the member (or the file) was not there; nothing is written then. */
export async function removeJsonMember(file: string, keyPath: KeyPath): Promise<boolean> {
  const text = await readText(file);
  if (text === undefined) { return false; }
  if (memberAt(parseOrThrow(file, text), keyPath) === undefined) { return false; }
  await writeFileAtomic(file, removeEdit(text, keyPath));
  return true;
}

export async function readJsonMembers(file: string, keyPath: KeyPath): Promise<string[]> {
  const text = await readText(file);
  if (text === undefined) { return []; }
  const node = memberAt(parseOrThrow(file, text), keyPath);
  return typeof node === 'object' && node !== null && !Array.isArray(node) ? Object.keys(node) : [];
}

function canonicalDir(dir: string): string {
  const slashed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Every top-level `projects` key naming `dir` — Claude writes the same folder under several spellings on Windows. */
export async function projectKeysFor(file: string, dir: string): Promise<string[]> {
  const want = canonicalDir(dir);
  return (await readJsonMembers(file, ['projects'])).filter((key) => canonicalDir(key) === want);
}
