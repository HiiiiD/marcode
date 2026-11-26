import * as fs from 'node:fs/promises';
import type { TranscriptItem } from '../protocol/messages';

/** Read-only view of another host's session JSONL: unparseable lines (a torn tail) are skipped. */
export async function readJsonlTranscript(file: string): Promise<TranscriptItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const items: TranscriptItem[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') { continue; }
    try { items.push(JSON.parse(line) as TranscriptItem); } catch { /* torn or corrupt line */ }
  }
  return items;
}
