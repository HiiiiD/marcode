import type { LayoutNode } from '../../client-core/layout-tree';
import type { Mounted } from './harness';
import { hydrateMsg } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

export const leaf = (sessionId: string, size = 50): LayoutNode => ({ kind: 'leaf', sessionId, size });
export const twoUp = (): LayoutNode => ({ kind: 'split', orientation: 'horizontal', size: 100, children: [leaf('s1'), leaf('s2')] });

export const hydrateTwo = () => hydrateMsg({
  sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
  layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
  snapshots: [snapshot('s1'), snapshot('s2')],
});

export const lastOf = <T extends Mounted['posted'][number]['t']>(posted: Mounted['posted'], t: T) =>
  [...posted].reverse().find((p): p is Extract<Mounted['posted'][number], { t: T }> => p.t === t);
