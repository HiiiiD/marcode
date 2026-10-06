import type { Zone } from '../keymap';

export interface ZoneBar { label: string; hints: string }

const HINTS: Record<Zone, { label: string; keys: string[] }> = {
  composer: { label: 'composer', keys: ['Enter send', 'Ctrl+J newline', '^V image', '^O open attachment'] },
  transcript: { label: 'transcript', keys: ['j/k select', 'Enter open', 'l attachments', 'f fork', 'End latest'] },
  roster: { label: 'roster', keys: ['j/k move', 'Enter focus', 'x hide', 'p pin', '/ filter'] },
  approval: { label: 'approval', keys: ['y allow', 'n deny', 'Enter confirm'] },
  question: { label: 'question', keys: ['↑/↓ choose', 'Space toggle', 'Enter submit'] },
};

const NEXT = 'Tab next';
const SEP = ' · ';

/** Hints are dropped from the right until the line fits; the label and the way out of the zone stay. */
export function zoneBar(zone: Zone, width: number): ZoneBar {
  const { label, keys } = HINTS[zone];
  const tab = zone === 'approval' || zone === 'question' ? [] : [NEXT];
  for (let n = keys.length; n >= 0; n--) {
    const hints = [...keys.slice(0, n), ...tab].join(SEP);
    if (label.length + 3 + hints.length <= width) { return { label, hints }; }
  }
  return { label, hints: '' };
}
