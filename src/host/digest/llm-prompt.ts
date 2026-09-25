import { clip, squash, SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

const USER_MAX = 600;
const ASSISTANT_MAX = 800;
const TOTAL_MAX = 16_000;
const FILES_MAX = 30;

const INSTRUCTIONS = [
  'You are summarizing a finished coding-agent session so a future session can find and reuse its work.',
  'Do not use any tools. Reply with ONE JSON object and nothing else, with exactly these keys:',
  'title (string, max 80 chars, what the session was about),',
  'request (string, the user\'s goal),',
  'outcome (string, max 200 chars, what was concluded or done),',
  'learned (string, durable facts worth remembering; may be empty),',
  'decisions (array of short strings), nextSteps (array of short strings).',
].join(' ');

export function buildSummaryPrompt(items: TranscriptItem[]): string {
  const lines: string[] = [];
  const edited = new Set<string>();
  let pending = '';
  const flush = () => {
    if (pending !== '') { lines.push(`ASSISTANT: ${clip(pending, ASSISTANT_MAX)}`); pending = ''; }
  };
  for (const item of items) {
    if (item.role === 'user') {
      flush();
      lines.push(`USER: ${clip(squash(item.text), USER_MAX)}`);
    } else if (item.role === 'assistant') {
      const text = squash(item.text);
      if (text !== '') { pending = text; }
    } else if (item.role === 'tool' && item.tool.kind === 'file-edit') {
      for (const file of item.tool.files) { edited.add(file.path); }
    }
  }
  flush();
  let body = lines.join('\n');
  if (body.length > TOTAL_MAX) {
    const half = TOTAL_MAX / 2;
    body = `${body.slice(0, half)}\n[…middle omitted…]\n${body.slice(-half)}`;
  }
  const files = [...edited].slice(0, FILES_MAX);
  return [
    INSTRUCTIONS, '', '<conversation>', body, '</conversation>',
    ...(files.length > 0 ? [`Files edited: ${files.join(', ')}`] : []),
  ].join('\n');
}

const text = (value: unknown, max: number): string =>
  (typeof value === 'string' ? clip(squash(value), max) : '');

const list = (value: unknown): string[] =>
  (Array.isArray(value)
    ? value
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => clip(squash(x), 160))
      .slice(0, 8)
    : []);

/** Throws on a reply with no usable title and outcome; the caller keeps the extractive digest. */
export function parseLlmDigest(reply: string, base: SessionDigest): SessionDigest {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) { throw new Error('no JSON object in summarizer reply'); }
  const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  const title = text(raw.title, 80);
  const outcome = text(raw.outcome, 240);
  if (title === '' || outcome === '') { throw new Error('summarizer reply missing title or outcome'); }
  const learned = text(raw.learned, 600);
  return {
    ...base,
    title,
    request: text(raw.request, 400) || base.request,
    outcome,
    ...(learned !== '' ? { learned } : {}),
    decisions: list(raw.decisions),
    nextSteps: list(raw.nextSteps),
    source: 'llm',
    summarizerVersion: SUMMARIZER_VERSION,
  };
}
