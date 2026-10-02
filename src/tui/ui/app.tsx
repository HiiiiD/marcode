import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import { squeezedIds, visibleRects } from '../../client-core/pane-geometry';
import type { SessionId } from '../../protocol/messages';
import type { Zone } from '../keymap';
import { bottomSlot } from '../view/bottom-slot';
import { launchPlan } from '../view/launch';
import type { PickerKind } from '../view/pickers';
import { DeleteConfirm } from './delete-confirm';
import { EmptyState } from './empty-state';
import { ModeDialog } from './mode-dialog';
import { ModelDialog } from './model-dialog';
import { NewSessionDialog, type HandoffSource } from './new-session-dialog';
import { NoticeLine } from './notice-line';
import { PaneTree } from './pane-tree';
import { Roster, ROSTER_W } from './roster';
import { ContextDialog } from './context-dialog';
import { StatusLine } from './status-line';
import { useTuiStore } from './store';
import { useAppKeys } from './use-app-keys';
import { useFocusFallback } from './use-focus-fallback';
import { usePaneChords } from './use-pane-chords';
import { usePaneLayout } from './use-pane-layout';

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
  const layout = usePaneLayout();
  const { shownId: focusedId, focusSession: focus } = useFocusFallback(layout.placeOrFocus);
  const { width, height } = useTerminalDimensions();
  const wide = width >= 100;
  const [rosterOn, setRosterOn] = useState<boolean | undefined>(undefined);
  const showRoster = rosterOn ?? wide;
  const [zone, setZone] = useState<PaneZone>('composer');
  const [dialog, setDialog] = useState(false);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [deleting, setDeleting] = useState<{ id: SessionId; title: string } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [handoffSource, setHandoffSource] = useState<HandoffSource | undefined>(undefined);
  const [kept, setKept] = useState<string | undefined>(undefined);
  const planned = useRef(false);

  const openNewSession = (source?: { id: SessionId; title: string }) => {
    const row = state.sessions.find((x) => x.id === focusedId);
    const focusedTitle = row ? row.name || row.title : undefined;
    const src = source ?? (focusedId && focusedTitle ? { id: focusedId, title: focusedTitle } : undefined);
    setHandoffSource(src ? { ...src, on: source !== undefined } : undefined);
    setDialog(true);
  };
  const pendingSplit = useRef<'horizontal' | 'vertical' | null>(null);
  const expectNewSession = () => { layout.expectArrival(); setKept(undefined); };

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

  useEffect(() => { if (props.initialNotice) { setNotice(props.initialNotice); } }, []);
  useEffect(() => props.subscribeNotices?.((text) => { setNotice(text); }), [props.subscribeNotices]);

  const slot = focusedId ? bottomSlot(summary, pane) : undefined;
  const zones: PaneZone[] = [...(focusedId ? ['composer', 'transcript'] as const : []), ...(showRoster ? ['roster'] as const : [])];
  const current: PaneZone = zones.includes(zone) ? zone : zones[0] ?? 'composer';
  const keyZone: Zone = slot?.kind === 'permission' ? 'approval' : slot?.kind === 'question' ? 'question' : current;
  const paneZone: PaneZone = keyZone === 'approval' || keyZone === 'question' ? 'composer' : current;
  const live = (z: PaneZone) => !dialog && !deleting && !picker && paneZone === z;

  const estimate = { w: width - (wide && showRoster ? ROSTER_W : 0), h: height - 2 };
  usePaneChords({
    area: { x: 0, y: 0, ...estimate },
    inert: dialog || deleting !== null || picker !== null,
    maximized, layout,
    onSplit: (orientation) => { pendingSplit.current = orientation; openNewSession(); },
    toggleMaximize: () => { setMaximized((v) => !v); },
  });

  useAppKeys({
    inert: dialog || deleting !== null || picker !== null, zone: keyZone, summary, quitWindowMs: props.quitWindowMs ?? 2000, onQuit: props.onQuit,
    toggleRoster: () => { setRosterOn(!showRoster); },
    openDialog: () => { openNewSession(); },
    openPicker: setPicker,
    cycleZone: () => { setZone(zones[(zones.indexOf(current) + 1) % zones.length] ?? 'composer'); },
  });

  const onFocusSession = (id: SessionId) => {
    focus(id);
    setZone('composer');
    if (!wide) { setRosterOn(false); }
  };

  const squeezed = squeezedIds(visibleRects(layout.root, focusedId, { x: 0, y: 0, ...estimate }, maximized).panes);
  const roster = showRoster
    ? <Roster focused={live('roster')} squeezed={squeezed} onFocusSession={onFocusSession} onAskDelete={(row) => { setDeleting(row); }} onHandoff={(row) => { openNewSession(row); }} />
    : null;
  const body = focusedId ? (
    <PaneTree
      estimate={estimate}
      focusedId={focusedId}
      liveZone={dialog || deleting || picker || paneZone === 'roster' ? null : paneZone}
      maximized={maximized}
      onFocus={focus}
      onHide={layout.hide}
      onResize={layout.applyRoot}
      onFork={(id, itemId) => { layout.armSplit('horizontal'); layout.expectArrival(); post({ t: 'fork-session', id, itemId }); }}
      onOpenPicker={setPicker}
    />
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
          handoff={handoffSource}
          onClose={() => { setDialog(false); pendingSplit.current = null; }}
          onCreated={(info) => {
            setDialog(false);
            const orientation = pendingSplit.current ?? (info.handoff ? 'horizontal' : null);
            pendingSplit.current = null;
            if (orientation) { layout.armSplit(orientation); }
            expectNewSession();
          }}
        />
      ) : null}
      {picker === 'model' && focusedId ? <ModelDialog sessionId={focusedId} onClose={() => { setPicker(null); }} /> : null}
      {(picker === 'mode' || picker === 'effort') && focusedId ? (
        <ModeDialog sessionId={focusedId} focus={picker === 'effort' ? 'effort' : 'modes'} onClose={() => { setPicker(null); }} />
      ) : null}
      {picker === 'context' && focusedId ? <ContextDialog sessionId={focusedId} onClose={() => { setPicker(null); }} /> : null}
      {deleting ? <DeleteConfirm id={deleting.id} title={deleting.title} onDone={() => { setDeleting(null); }} /> : null}
      <box flexDirection="column" flexShrink={0}>
        <StatusLine
          sessionId={focusedId}
          width={width}
          onOpenContext={summary && !summary.owner ? () => { setPicker('context'); } : undefined}
        />
        <NoticeLine />
      </box>
    </box>
  );
}
