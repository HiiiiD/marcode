import type { FileRef, RefKind, TranscriptItem } from '../protocol/messages';

/** One resolved reference, ready to be appended to a prompt. */
export interface ResolvedBlock { title: string; kind: RefKind | 'file'; text: string }

/**
 * The text a reference resolves to, or `undefined` when the source has
 * nothing to give.
 *
 * Searches backwards, so "most recent" costs no sort. `excludeItemId` is the
 * live session's currently-open assistant item: an in-flight answer is never
 * a candidate, which is what lets a reference resolve against a session that
 * is still running without ever pulling half a sentence.
 *
 * `plan` deliberately searches across turns rather than stopping at the last
 * user message. A plan is often several turns old by the time it is handed
 * off, and a rule that found nothing in that case would send the user looking
 * for a payload that is plainly on screen.
 */
export function findPayload(
  items: TranscriptItem[], kind: RefKind, excludeItemId?: string,
): string | undefined {
  if (kind === 'message') { return buildRecap(items, excludeItemId); }

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.id === excludeItemId) { continue; }
    // Same emptiness guard as the closing-note branch in buildRecap below: an
    // empty plan resolves to `''`, which renders as an empty disclosure chip
    // rather than falling through to the previous plan or being reported as
    // missing.
    if (item.role === 'tool' && item.state === 'ok' && item.tool.kind === 'plan'
      && item.tool.text.trim().length > 0) {
      return item.tool.text;
    }
  }
  return undefined;
}

const MAX_FILES = 6;
const MAX_COMMANDS = 4;
const MAX_PLAN_CHARS = 400;

/**
 * What a `message` reference actually resolves to.
 *
 * A mentioned session's single last message can be the wrong turn entirely —
 * a session that ended on a rate limit or other transient failure has its
 * last real content sitting turns earlier, and picking only that one message
 * either surfaces something stale or nothing at all. This instead walks the
 * whole transcript and reports what the session *did*: files it touched,
 * commands it ran, its last plan, and its last word — the way a human
 * skimming the pane above would summarize it, not a single quoted line.
 *
 * Deliberately says nothing about `role: 'error'` items: a rate limit or
 * crash is the receiving session's problem to route around, not content for
 * it to reason about.
 */
function buildRecap(items: TranscriptItem[], excludeItemId?: string): string | undefined {
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const commands: string[] = [];
  const seenCommands = new Set<string>();
  let planText: string | undefined;

  for (const item of items) {
    if (item.role !== 'tool' || item.state !== 'ok') { continue; }
    const tool = item.tool;
    if (tool.kind === 'file-edit') {
      for (const f of tool.files) {
        if (!seenFiles.has(f.path)) { seenFiles.add(f.path); files.push(f.path); }
      }
    } else if (tool.kind === 'command') {
      if (!seenCommands.has(tool.command)) { seenCommands.add(tool.command); commands.push(tool.command); }
    } else if (tool.kind === 'plan' && tool.text.trim().length > 0) {
      planText = tool.text;
    }
  }

  let closingNote: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.id === excludeItemId) { continue; }
    if (item.role === 'assistant' && item.text.trim().length > 0) {
      closingNote = item.text;
      break;
    }
  }

  const lines: string[] = [];
  if (files.length > 0) { lines.push(`Touched: ${capped(files, MAX_FILES)}`); }
  if (commands.length > 0) { lines.push(`Ran: ${capped(commands, MAX_COMMANDS)}`); }
  if (planText !== undefined) { lines.push(`Plan: ${truncate(planText, MAX_PLAN_CHARS)}`); }
  if (closingNote !== undefined) { lines.push(closingNote); }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

function capped(values: string[], max: number): string {
  if (values.length <= max) { return values.join(', '); }
  return `${values.slice(0, max).join(', ')} (+${values.length - max} more)`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/**
 * The prose as typed, with each payload appended after it as a delimited
 * block.
 *
 * Positional rather than substitutional: the composer's `@agent-2 plan` token
 * stays readable in the text and the content follows it, so there is no
 * placeholder scheme that a user editing their own message could break.
 */
export function composePrompt(prose: string, blocks: ResolvedBlock[]): string {
  if (blocks.length === 0) { return prose; }
  const rendered = blocks.map((b) =>
    `--- ${b.kind} from ${b.title} ---\n${b.text}\n--- end ${b.kind} from ${b.title} ---`);
  return [prose, ...rendered].join('\n\n');
}

const MAX_FILE_CHARS = 4000;

/**
 * `@file` mentions, resolved to their content. One reference per row, unlike
 * session refs' all-or-nothing prompt: a file deleted between being typed and
 * sent is reported missing on its own, the same shape `resolveRefs` already
 * uses for sessions.
 *
 * `readFile` is injected rather than this module reaching for `node:fs`
 * itself — the caller resolves `FileRef.path` against whichever session's cwd
 * it belongs to, and this stays a pure function to test.
 */
export async function resolveFileRefs(
  refs: FileRef[], readFile: (path: string) => Promise<string | undefined>,
): Promise<{ blocks: ResolvedBlock[]; missing: FileRef[] }> {
  const blocks: ResolvedBlock[] = [];
  const missing: FileRef[] = [];

  for (const ref of refs) {
    const text = await readFile(ref.path);
    if (text === undefined) { missing.push(ref); continue; }
    blocks.push({ title: ref.path, kind: 'file', text: truncate(text, MAX_FILE_CHARS) });
  }

  return { blocks, missing };
}
