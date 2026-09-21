import type { TranscriptItem } from '../protocol/messages';

const GOAL_MAX = 160;
const OUTCOME_MAX = 200;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Top-level items only: a subagent's children are its own work, summarised by its own spawn card. */
export function digestSession(items: TranscriptItem[]): string {
  let goal = '';
  let outcome = '';
  const edited = new Set<string>();
  for (const item of items) {
    if (item.role === 'user' && goal === '') { goal = squash(item.text); }
    if (item.role === 'assistant') {
      const text = squash(item.text);
      if (text !== '') { outcome = text; }
    }
    if (item.role === 'tool' && item.tool.kind === 'file-edit') {
      for (const file of item.tool.files) { edited.add(file.path); }
    }
  }
  if (goal === '') { return ''; }
  let out = clip(goal, GOAL_MAX);
  if (outcome !== '') { out += ` → ${clip(outcome, OUTCOME_MAX)}`; }
  if (edited.size > 0) { out += ` · ${edited.size} ${edited.size === 1 ? 'file' : 'files'} edited`; }
  return out;
}
