export type Zone = 'composer' | 'transcript' | 'roster' | 'approval' | 'question';
export interface KeyInput { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type Action =
  | { do: 'toggle-roster' } | { do: 'new-session' } | { do: 'interrupt' } | { do: 'quit-request' }
  | { do: 'cycle-zone' } | { do: 'cycle-model' } | { do: 'cycle-effort' } | { do: 'cycle-mode' }
  | { do: 'send' } | { do: 'newline' } | { do: 'history-prev' }
  | { do: 'item-next' } | { do: 'item-prev' } | { do: 'toggle-item' } | { do: 'page-up' } | { do: 'page-down' } | { do: 'repin' }
  | { do: 'roster-next' } | { do: 'roster-prev' } | { do: 'roster-focus' } | { do: 'roster-hide' } | { do: 'roster-rename' }
  | { do: 'allow' } | { do: 'deny' } | { do: 'confirm' }
  | { do: 'option-next' } | { do: 'option-prev' } | { do: 'option-toggle' } | { do: 'submit-answers' }
  | { do: 'refresh-catalog' };

const act = <T extends Action['do']>(d: T) => ({ do: d }) as Extract<Action, { do: T }>;

function globalAction(key: KeyInput, zone: Zone, ctx: { running: boolean }): Action | undefined {
  if (key.ctrl) {
    switch (key.name) {
      case 'b': return act('toggle-roster');
      case 'n': return act('new-session');
      case 'c': return ctx.running ? act('interrupt') : act('quit-request');
      case 'p': return act('cycle-model');
      case 'e': return act('cycle-effort');
      case 'r': return act('refresh-catalog');
    }
    return undefined;
  }
  if (key.name === 'escape') { return ctx.running ? act('interrupt') : undefined; }
  if (key.name === 'tab') {
    if (key.shift) { return act('cycle-mode'); }
    return zone === 'approval' || zone === 'question' ? undefined : act('cycle-zone');
  }
  return undefined;
}

export function actionFor(zone: Zone, key: KeyInput, ctx: { running: boolean }): Action | undefined {
  const global = globalAction(key, zone, ctx);
  if (global) { return global; }
  if (key.ctrl && key.name === 'j' && zone === 'composer') { return act('newline'); }
  if (key.name === 'linefeed' && zone === 'composer') { return act('newline'); }
  if (key.ctrl) { return undefined; }
  switch (zone) {
    case 'composer':
      if (key.name === 'return') { return key.meta ? act('newline') : act('send'); }
      if (key.name === 'up') { return act('history-prev'); }
      return undefined;
    case 'transcript':
      switch (key.name) {
        case 'j': return act('item-next');
        case 'k': return act('item-prev');
        case 'return': return act('toggle-item');
        case 'pageup': return act('page-up');
        case 'pagedown': return act('page-down');
        case 'end': return act('repin');
      }
      return undefined;
    case 'roster':
      switch (key.name) {
        case 'j': return act('roster-next');
        case 'k': return act('roster-prev');
        case 'return': return act('roster-focus');
        case 'x': return act('roster-hide');
        case 'r': return act('roster-rename');
      }
      return undefined;
    case 'approval':
      switch (key.name) {
        case 'y': return act('allow');
        case 'n': return act('deny');
        case 'return': return act('confirm');
      }
      return undefined;
    case 'question':
      switch (key.name) {
        case 'up': return act('option-prev');
        case 'down': return act('option-next');
        case 'space': return act('option-toggle');
        case 'return': return act('submit-answers');
      }
      return undefined;
  }
}
