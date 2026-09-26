import type { HostToWebview, PaneLayout } from '../protocol/messages';
import { leafSessionIds } from '../webview/components/layout-tree';

export const PANE_COMMANDS = [
  ...Array.from({ length: 9 }, (_, i) => `marcode.focusPane.${i + 1}`),
  'marcode.focusNextPane',
  'marcode.focusPrevPane',
  'marcode.toggleMaximizePane',
];

export function paneCommandMessage(command: string, layout: PaneLayout): HostToWebview | undefined {
  const slot = /^marcode\.focusPane\.(\d)$/.exec(command);
  if (slot) {
    const id = leafSessionIds(layout.root)[Number(slot[1]) - 1];
    return id === undefined ? undefined : { t: 'focus-pane', id };
  }
  if (command === 'marcode.focusNextPane') { return { t: 'step-pane', delta: 1 }; }
  if (command === 'marcode.focusPrevPane') { return { t: 'step-pane', delta: -1 }; }
  if (command === 'marcode.toggleMaximizePane') { return { t: 'toggle-maximize-pane' }; }
  return undefined;
}
