import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { SessionId } from '../../protocol/messages';
import type { Zone } from '../keymap';
import { bottomSlot } from '../view/bottom-slot';
import { launchPlan } from '../view/launch';
import { BottomSlotView } from './bottom-slot';
import { DeleteConfirm } from './delete-confirm';
import { EmptyState } from './empty-state';
import { NewSessionDialog } from './new-session-dialog';
import { NoticeLine } from './notice-line';
import { Roster } from './roster';
import { StatusLine } from './status-line';
import { useTuiStore } from './store';
import { Transcript } from './transcript/transcript';
import { useAppKeys } from './use-app-keys';
import { useFocusFallback } from './use-focus-fallback';

export interface AppProps {
  launchCwd: string;
  prompt?: string;
  forceNew: boolean;
  loginCommands: Record<string, string>;
  onQuit(): void;
  initialNotice?: string;
  subscribeNotices?: (cb: (text: string) => void) => () => void;
  quitWindowMs?: number;
}

type PaneZone = 'composer' | 'transcript' | 'roster';

export function App(props: AppProps) {
  const { state, post, setNotice } = useTuiStore();
  const { shownId: focusedId, focusSession: focus } = useFocusFallback();
  const { width } = useTerminalDimensions();
  const wide = width >= 100;
  const [rosterOn, setRosterOn] = useState<boolean | undefined>(undefined);
  const showRoster = rosterOn ?? wide;
  const [zone, setZone] = useState<PaneZone>('composer');
  const [dialog, setDialog] = useState(false);
  const [deleting, setDeleting] = useState<{ id: SessionId; title: string } | null>(null);
  const [kept, setKept] = useState<string | undefined>(undefined);
  const planned = useRef(false);
  const seen = useRef<Set<SessionId> | null>(null);

  const knownIds = () => new Set([...state.sessions.map((s) => s.id), ...Object.keys(state.byId)]);
  const expectNewSession = () => { seen.current = knownIds(); };

  const pane = focusedId ? state.byId[focusedId] : undefined;
  const summary = pane?.summary ?? state.sessions.find((s) => s.id === focusedId);
  const plan = launchPlan({
    ready: state.ready, probing: state.probing !== false, sessions: state.sessions, catalog: state.catalog,
    layout: state.layout, prompt: props.prompt, forceNew: props.forceNew,
  });

  useEffect(() => {
    if (planned.current || plan.kind === 'wait') { return; }
    planned.current = true;
    if (plan.kind === 'resume') { focus(plan.sessionId); }
    else if (plan.kind === 'create') {
      expectNewSession();
      post({
        t: 'create-session', providerId: plan.providerId, cwd: props.launchCwd, model: plan.model,
        ...(plan.seed ? { seed: plan.seed } : {}),
      });
    } else { setKept(plan.pendingPrompt); }
  });

  useEffect(() => {
    if (!seen.current) { return; }
    const before = seen.current;
    const fresh = [...knownIds()].find((id) => !before.has(id));
    if (fresh) { seen.current = null; setKept(undefined); focus(fresh); }
  }, [state.sessions, state.byId]);

  useEffect(() => { if (props.initialNotice) { setNotice(props.initialNotice); } }, []);
  useEffect(() => props.subscribeNotices?.((text) => { setNotice(text); }), [props.subscribeNotices]);

  const slot = focusedId ? bottomSlot(summary, pane) : undefined;
  const zones: PaneZone[] = [...(focusedId ? ['composer', 'transcript'] as const : []), ...(showRoster ? ['roster'] as const : [])];
  const current: PaneZone = zones.includes(zone) ? zone : zones[0] ?? 'composer';
  const keyZone: Zone = slot?.kind === 'permission' ? 'approval' : slot?.kind === 'question' ? 'question' : current;
  const paneZone: PaneZone = keyZone === 'approval' || keyZone === 'question' ? 'composer' : current;
  const live = (z: PaneZone) => !dialog && !deleting && paneZone === z;

  useAppKeys({
    inert: dialog || deleting !== null, zone: keyZone, summary, quitWindowMs: props.quitWindowMs ?? 2000, onQuit: props.onQuit,
    toggleRoster: () => { setRosterOn(!showRoster); },
    openDialog: () => { setDialog(true); },
    cycleZone: () => { setZone(zones[(zones.indexOf(current) + 1) % zones.length] ?? 'composer'); },
  });

  const onFocusSession = (id: SessionId) => {
    focus(id);
    setZone('composer');
    if (!wide) { setRosterOn(false); }
  };

  const roster = showRoster
    ? <Roster focused={live('roster')} onFocusSession={onFocusSession} onAskDelete={(row) => { setDeleting(row); }} />
    : null;
  const body = focusedId ? (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
      <Transcript sessionId={focusedId} focused={live('transcript')} />
      <box flexShrink={0}><BottomSlotView sessionId={focusedId} focused={live('composer')} /></box>
    </box>
  ) : (
    <box flexGrow={1}>
      <EmptyState pendingPrompt={kept} loginCommands={props.loginCommands} />
    </box>
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
        {wide ? roster : null}
        {body}
        {!wide && roster ? (
          <box position="absolute" left={0} top={0} height="100%" zIndex={10} backgroundColor="black">{roster}</box>
        ) : null}
      </box>
      {dialog ? (
        <NewSessionDialog
          cwd={props.launchCwd}
          initialPrompt={kept}
          onClose={() => { setDialog(false); }}
          onCreated={() => { setDialog(false); expectNewSession(); }}
        />
      ) : null}
      {deleting ? <DeleteConfirm id={deleting.id} title={deleting.title} onDone={() => { setDeleting(null); }} /> : null}
      <box flexDirection="column" flexShrink={0}>
        <StatusLine sessionId={focusedId} width={width} />
        <NoticeLine />
      </box>
    </box>
  );
}
