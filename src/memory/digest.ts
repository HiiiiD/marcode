import type { TranscriptItem } from '../protocol/messages';

export const SUMMARIZER_VERSION = 1;

const TITLE_MAX = 160;
const REQUEST_MAX = 400;
const OUTCOME_MAX = 200;

export interface SessionDigest {
  title: string;
  request: string;
  outcome: string;
  filesEdited: string[];
  learned?: string;
  decisions?: string[];
  nextSteps?: string[];
  source: 'extractive' | 'llm';
  summarizerVersion: number;
  forUpdatedAt: number;
}

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Top-level items only: a subagent's children are its own work, summarised by its own spawn card. */
export function extractiveDigest(items: TranscriptItem[], forUpdatedAt: number): SessionDigest | undefined {
  let request = '';
  let outcome = '';
  const edited = new Set<string>();
  for (const item of items) {
    if (item.role === 'user' && request === '') { request = squash(item.text); }
    if (item.role === 'assistant') {
      const text = squash(item.text);
      if (text !== '') { outcome = text; }
    }
    if (item.role === 'tool' && item.tool.kind === 'file-edit') {
      for (const file of item.tool.files) { edited.add(file.path); }
    }
  }
  if (request === '') { return undefined; }
  return {
    title: clip(request, TITLE_MAX),
    request: clip(request, REQUEST_MAX),
    outcome: clip(outcome, OUTCOME_MAX),
    filesEdited: [...edited],
    source: 'extractive',
    summarizerVersion: SUMMARIZER_VERSION,
    forUpdatedAt,
  };
}

export function indexLine(d: SessionDigest): string {
  let out = d.title;
  if (d.outcome !== '') { out += ` → ${d.outcome}`; }
  const n = d.filesEdited.length;
  if (n > 0) { out += ` · ${n} ${n === 1 ? 'file' : 'files'} edited`; }
  return out;
}

export function digestText(d: SessionDigest): string {
  const lines = [`Title: ${d.title}`, `Request: ${d.request}`];
  if (d.outcome !== '') { lines.push(`Outcome: ${d.outcome}`); }
  if (d.learned) { lines.push(`Learned: ${d.learned}`); }
  if (d.decisions && d.decisions.length > 0) { lines.push('Decisions:', ...d.decisions.map((x) => `- ${x}`)); }
  if (d.nextSteps && d.nextSteps.length > 0) { lines.push('Next steps:', ...d.nextSteps.map((x) => `- ${x}`)); }
  if (d.filesEdited.length > 0) { lines.push(`Files edited: ${d.filesEdited.join(', ')}`); }
  lines.push(`(${d.source} summary)`);
  return lines.join('\n');
}
