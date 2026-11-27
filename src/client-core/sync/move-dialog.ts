import type { HostToWebview, MovePanel, MoveStatus, SessionId, WebviewToHost } from '../../protocol/messages';
import { seenAt } from '../device-label';

export interface MoveChoice { root?: string; createWorktree?: string; cancelTurn: boolean }
export interface MoveSlice { id: SessionId; panel: MovePanel; status?: MoveStatus }
export interface MoveDialogView {
  title: string; lines: string[]; options: Array<{ key: string; label: string; detail?: string }>; selected?: string;
  checkbox?: string; progress?: string; error?: string;
  action: { label: string; disabled: boolean; kind: 'move' | 'take-over' | 'close' };
}

/** The dialog's slice of client state: the panel the host last answered, and only that session's statuses. */
export function reduceMove(slice: MoveSlice | undefined, msg: HostToWebview): MoveSlice | undefined {
  if (msg.t === 'move-panel') { return { id: msg.panel.id, panel: msg.panel }; }
  if (msg.t === 'move-status' && slice && msg.id === slice.id) { return { ...slice, status: msg.status }; }
  return slice;
}

const folder = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const worktreeOffered = (panel: MovePanel): boolean =>
  panel.branch !== undefined && !panel.checkouts.some((c) => c.branch === panel.branch);

export function initialChoice(panel: MovePanel): MoveChoice {
  if (panel.defaultRoot && !worktreeOffered(panel)) { return { root: panel.defaultRoot, cancelTurn: false }; }
  if (worktreeOffered(panel)) { return { createWorktree: panel.branch!, cancelTurn: false }; }
  return { ...(panel.defaultRoot ? { root: panel.defaultRoot } : {}), cancelTurn: false };
}

export const choiceKey = (choice: MoveChoice): string | undefined =>
  choice.createWorktree ? `worktree:${choice.createWorktree}` : choice.root ? `root:${choice.root}` : undefined;

export function choiceFromKey(key: string, cancelTurn: boolean): MoveChoice {
  return key.startsWith('worktree:') ? { createWorktree: key.slice('worktree:'.length), cancelTurn } : { root: key.slice('root:'.length), cancelTurn };
}

const STEP: Record<Extract<MoveStatus, { state: 'waiting' }>['step'], (owner: string) => string> = {
  reply: (owner) => `Waiting for ${owner} to hand it over…`,
  transcript: () => 'Copying the transcript…',
  thread: () => 'Restoring the agent…',
  claim: () => 'Claiming the session…',
};

export function moveDialogView(input: { panel: MovePanel; status?: MoveStatus; choice: MoveChoice; name: string; running: boolean; now?: number }): MoveDialogView {
  const { panel, status, choice, name } = input;
  if (panel.mode === 'unavailable') {
    return { title: `Can't move "${name}"`, lines: panel.reason ? [panel.reason] : [], options: [], action: { label: 'Close', disabled: false, kind: 'close' } };
  }
  const takeOver = panel.mode === 'take-over';
  const lines = [panel.thread === 'restored'
    ? 'The agent thread comes along.'
    : 'The agent restarts from the transcript; earlier tool output is not in its context.'];
  if (takeOver) {
    lines.push(`${panel.ownerName} was last seen ${seenAt(panel.lastSeenAt, input.now)}. A turn it was running is lost, and code it didn't push isn't here.`);
  }
  const options: MoveDialogView['options'] = panel.checkouts.map((c) => ({ key: `root:${c.root}`, label: c.branch ? `${folder(c.root)} · ${c.branch}` : folder(c.root), detail: c.root }));
  if (worktreeOffered(panel)) { options.push({ key: `worktree:${panel.branch!}`, label: `New worktree for ${panel.branch!}` }); }
  const kind = takeOver ? 'take-over' as const : 'move' as const;
  const moving = status?.state === 'waiting';
  const selected = choiceKey(choice);
  return {
    title: takeOver ? `Take over "${name}"` : `Move "${name}" here`,
    lines, options, ...(selected ? { selected } : {}),
    ...(!takeOver && input.running ? { checkbox: `Stop the running turn on ${panel.ownerName}` } : {}),
    ...(moving ? { progress: STEP[status.step](panel.ownerName) } : {}),
    ...(status?.state === 'failed' ? { error: status.reason } : {}),
    action: moving
      ? { label: 'Moving…', disabled: true, kind }
      : { label: takeOver ? 'Take over' : 'Move here', disabled: selected === undefined, kind },
  };
}

export function moveMessage(panel: MovePanel, choice: MoveChoice): WebviewToHost | undefined {
  if (panel.mode === 'unavailable') { return undefined; }
  const target = choice.createWorktree ? { createWorktree: choice.createWorktree } : choice.root ? { root: choice.root } : undefined;
  if (!target) { return undefined; }
  return panel.mode === 'take-over'
    ? { t: 'take-over-session', id: panel.id, target }
    : { t: 'move-session', id: panel.id, target, cancelTurn: choice.cancelTurn };
}
