import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

export interface HandoffSource { id: SessionId; title: string; on: boolean }

interface Props {
  cwd: string;
  initialPrompt?: string;
  handoff?: HandoffSource;
  onClose(): void;
  onCreated(info: { handoff: boolean }): void;
}

export function NewSessionDialog(props: Props) {
  const { state, post } = useTuiStore();
  const providers = state.catalog;
  const st = useSyncState({
    pi: 0, mi: 0, step: 'provider' as 'provider' | 'model' | 'seed', handoff: props.handoff?.on ?? false, seed: '',
  });
  const sent = useRef(false);

  const create = (providerId: string, model: string | undefined, handoff: boolean, seed: string) => {
    sent.current = true;
    const source = props.handoff;
    post({
      t: 'create-session', providerId, cwd: props.cwd, model,
      ...(handoff && source
        ? { seed: { text: seed, handoffFrom: source.id } }
        : props.initialPrompt ? { seed: { text: props.initialPrompt } } : {}),
    });
    props.onCreated({ handoff: handoff && source !== undefined });
  };

  useKeyboard((key) => {
    if (key.name === 'escape') { props.onClose(); return; }
    const cur = st.get();
    const provider = providers[cur.pi];
    if (!provider || sent.current) { return; }
    const models = provider.models;
    if (cur.step === 'seed') {
      if (key.name === 'return') { create(provider.id, models[cur.mi]?.id, true, cur.seed); }
      else if (key.name === 'backspace') { st.set({ seed: cur.seed.slice(0, -1) }); }
      else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) { st.set({ seed: cur.seed + key.sequence }); }
      return;
    }
    if (key.name === 'h' && props.handoff) { st.set({ handoff: !cur.handoff }); return; }
    const count = cur.step === 'provider' ? providers.length : models.length;
    const move = (d: number) => {
      const field = cur.step === 'provider' ? 'pi' : 'mi';
      st.set({ [field]: Math.max(0, Math.min(count - 1, cur[field] + d)) });
    };
    if (key.name === 'down' || key.name === 'j') { move(1); }
    else if (key.name === 'up' || key.name === 'k') { move(-1); }
    else if (key.name === 'return') {
      if (cur.step === 'provider' && models.length > 1) { st.set({ step: 'model', mi: 0 }); return; }
      if (cur.handoff && props.handoff) { st.set({ step: 'seed' }); return; }
      create(provider.id, models[cur.mi]?.id, false, '');
    }
  });

  const { pi, mi, step, handoff, seed } = st.view;
  const models = providers[pi]?.models ?? [];
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="New session">
        {providers.length === 0 ? <text fg="gray">No provider available.</text> : null}
        {step === 'seed' ? (
          <text>{`Prompt for the new session: ${seed}▏`}</text>
        ) : step === 'provider'
          ? providers.map((p, i) => <text key={p.id} attributes={i === pi ? 1 : 0}>{`${i === pi ? '›' : ' '} ${p.displayName}`}</text>)
          : models.map((mo, i) => <text key={mo.id} attributes={i === mi ? 1 : 0}>{`${i === mi ? '›' : ' '} ${mo.displayName}`}</text>)}
        {props.handoff && step !== 'seed' ? <text fg="gray">{`${handoff ? '[x]' : '[ ]'} Hand off from ${props.handoff.title} (h)`}</text> : null}
        <text fg="gray">{`${props.cwd} — Enter create, Esc cancel`}</text>
      </Dialog>
    </box>
  );
}
