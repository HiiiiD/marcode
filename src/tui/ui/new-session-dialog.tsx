import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import { useTuiStore } from './store';
import { useSyncState } from './use-sync-state';

export function NewSessionDialog(props: { cwd: string; initialPrompt?: string; onClose(): void; onCreated(): void }) {
  const { state, post } = useTuiStore();
  const providers = state.catalog;
  const st = useSyncState({ pi: 0, mi: 0, step: 'provider' as 'provider' | 'model' });
  const sent = useRef(false);

  useKeyboard((key) => {
    if (key.name === 'escape') { props.onClose(); return; }
    const cur = st.get();
    const provider = providers[cur.pi];
    if (!provider || sent.current) { return; }
    const models = provider.models;
    const count = cur.step === 'provider' ? providers.length : models.length;
    const move = (d: number) => {
      const field = cur.step === 'provider' ? 'pi' : 'mi';
      st.set({ [field]: Math.max(0, Math.min(count - 1, cur[field] + d)) });
    };
    if (key.name === 'down' || key.name === 'j') { move(1); }
    else if (key.name === 'up' || key.name === 'k') { move(-1); }
    else if (key.name === 'return') {
      if (cur.step === 'provider' && models.length > 1) { st.set({ step: 'model', mi: 0 }); return; }
      sent.current = true;
      post({
        t: 'create-session', providerId: provider.id, cwd: props.cwd, model: models[cur.mi]?.id,
        ...(props.initialPrompt ? { seed: { text: props.initialPrompt } } : {}),
      });
      props.onCreated();
    }
  });

  const { pi, mi, step } = st.view;
  const models = providers[pi]?.models ?? [];
  return (
    <box flexDirection="column" flexShrink={0} border borderStyle="double" title="New session" paddingX={1}>
      {providers.length === 0 ? <text fg="gray">No provider available.</text> : null}
      {step === 'provider'
        ? providers.map((p, i) => <text key={p.id} attributes={i === pi ? 1 : 0}>{`${i === pi ? '›' : ' '} ${p.displayName}`}</text>)
        : models.map((mo, i) => <text key={mo.id} attributes={i === mi ? 1 : 0}>{`${i === mi ? '›' : ' '} ${mo.displayName}`}</text>)}
      <text fg="gray">{`${props.cwd} — Enter create, Esc cancel`}</text>
    </box>
  );
}
