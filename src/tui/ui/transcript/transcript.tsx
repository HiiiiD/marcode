import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, SessionId } from '../../../protocol/messages';
import { summarizeSubagent } from '../../../client-core/subagent-window';
import { actionFor } from '../../keymap';
import { transcriptRows, type ToolItem, type TranscriptRow } from '../../view/transcript-rows';
import { foldWorkerGroups } from '../../view/worker-groups';
import { subagentLabel } from '../../../client-core/subagent-window';
import { useTuiStore } from '../store';
import { useTheme } from '../termcn/hooks/use-theme';
import { useTranscriptGaps } from '../transcript-gaps';
import { BAR_CHARS } from './bar-border';
import type { RelocationKeys } from './relocation-card';
import { RowView } from './row';

// Every row reserves the bar's column, so selecting one never shifts the text.
const GUTTER_CHARS = { ...BAR_CHARS, vertical: ' ' };

const blockedAny = (items: ToolItem[]) => items.some((i) => summarizeSubagent(i, 0).blocked);

const hostedWorker = (row: TranscriptRow | undefined) =>
  row?.kind === 'tool' && row.item.tool.kind === 'subagent' && row.item.tool.childSessionId !== undefined
    ? { id: row.item.tool.childSessionId, item: row.item } : undefined;

const isMessage = (row: TranscriptRow | undefined) => row?.kind === 'user' || row?.kind === 'assistant';

// Outside the bar, so a selected row's bar stops at its last line instead of running through the spacer.
// Closed tool rows stack as one log; a message, or an open card's body, gets air on both sides.
function gapAfter(row: TranscriptRow, next: TranscriptRow | undefined, opened: boolean, gaps: { message: number; tool: number }): number {
  if (next === undefined) { return 0; }
  // An opened team hangs its workers right under it; the air goes after the last one.
  if (row.kind === 'workers' && opened) { return 0; }
  if (row.kind === 'tool' && row.member) { return next.kind === 'tool' && next.member ? gaps.tool : gaps.message; }
  if (isMessage(row) || isMessage(next) || opened) { return gaps.message; }
  return gaps.tool;
}

export function Transcript({ sessionId, focused, onFork, relocationKeys = 'none' }: {
  sessionId: SessionId; focused: boolean; onFork?(itemId: string): void; relocationKeys?: RelocationKeys;
}) {
  const { state, post, setNotice, chordArmed, setWorkerTarget } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [attachCursor, setAttachCursor] = useState<{ rowId: string; index: number } | undefined>(undefined);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // A team that needs you opens itself, like a blocked subagent card, until the user closes it.
  const teamOpen = (id: string, items: ToolItem[]) => open.has(id) || (blockedAny(items) && !closed.has(id));
  const flat = useMemo(() => transcriptRows(pane?.items ?? [], running), [pane?.items, running]);
  const rows = useMemo(() => foldWorkerGroups(flat, (id, members) => teamOpen(id, members.map((m) => m.item))), [flat, open, closed]);
  const asked = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const heightBefore = useRef<number | undefined>(undefined);

  // The stock edge-drag speeds (up to 72 rows/s) overshoot a text selection; these are read each frame.
  useEffect(() => {
    const box = scroll.current as unknown as Record<string, number> | null;
    if (!box) { return; }
    box.autoScrollSpeedSlow = 3;
    box.autoScrollSpeedMedium = 10;
    box.autoScrollSpeedFast = 20;
  }, []);

  const first = pane?.items[0]?.id;
  const hasMore = pane?.hasMore === true;
  // Only a user scroll asks: a render-driven ask would chain through every page, because a prepend leaves no scroll to anchor on.
  const askOlder = () => {
    const box = scroll.current;
    if (!hasMore || !first || asked.current === first || !box || box.scrollTop > 0) { return; }
    asked.current = first;
    heightBefore.current = box.scrollHeight;
    post({ t: 'load-more', id: sessionId, beforeItemId: first });
  };

  // Keep the reader on the row they were on once older items land above it.
  useEffect(() => {
    if (heightBefore.current === undefined) { return; }
    const before = heightBefore.current;
    const t = setTimeout(() => {
      const box = scroll.current;
      if (box && box.scrollHeight > before) { box.scrollBy(box.scrollHeight - before, 'absolute'); heightBefore.current = undefined; }
    }, 0);
    return () => clearTimeout(t);
  }, [first]);

  // Entering the zone selects the newest message, so the zone change shows up on screen at once.
  useEffect(() => {
    if (focused && cursorId === undefined && rows.length > 0) { setCursorId(rows[rows.length - 1]?.id); }
  }, [focused]);

  const cursor = cursorId === undefined ? -1 : rows.findIndex((r) => r.id === cursorId);
  // A worker row vanishes when its team closes; the cursor falls back to the team row instead of to nothing.
  useEffect(() => {
    if (cursorId === undefined || cursor >= 0) { return; }
    const team = rows.find((r) => r.kind === 'workers' && r.items.some((i) => i.id === cursorId));
    if (team) { setCursorId(team.id); }
  }, [cursorId, cursor, rows]);
  useEffect(() => {
    if (cursorId !== undefined) { scroll.current?.scrollChildIntoView(cursorId); }
  }, [cursorId]);

  const toggleRow = (row: TranscriptRow | undefined) => {
    if (row?.kind === 'compaction') {
      if (row.summary === undefined) { return; }
      const id = row.id;
      setOpen((o) => { const n = new Set(o); if (n.has(id)) { n.delete(id); } else { n.add(id); } return n; });
      return;
    }
    if (row?.kind === 'workers') {
      const id = row.id;
      const blocked = blockedAny(row.items);
      const effective = teamOpen(id, row.items);
      const flipTeam = (s: ReadonlySet<string>, on: boolean) => { const n = new Set(s); if (on) { n.add(id); } else { n.delete(id); } return n; };
      setOpen((o) => flipTeam(o, !effective));
      setClosed((c) => flipTeam(c, effective && blocked));
      return;
    }
    if (row?.kind !== 'tool') { return; }
    const id = row.id;
    if (row.userShell) {
      // A set member here means collapsed: these cards open by default.
      setOpen((o) => { const n = new Set(o); if (n.has(id)) { n.delete(id); } else { n.add(id); } return n; });
      return;
    }
    const blocked = row.item.tool.kind === 'subagent' && summarizeSubagent(row.item, 0).blocked;
    const effective = open.has(id) || (blocked && !closed.has(id));
    const flip = (s: ReadonlySet<string>, on: boolean) => { const n = new Set(s); if (on) { n.add(id); } else { n.delete(id); } return n; };
    setOpen((o) => flip(o, !effective));
    setClosed((c) => flip(c, effective && blocked));
  };

  useKeyboard((key) => {
    if (!focused || key.defaultPrevented || chordArmed.current) { return; }
    const action = actionFor('transcript', key, { running });
    if (!action) { return; }
    const box = scroll.current;
    const current = rows[cursor];
    const sent = current?.kind === 'user' ? current.attachments : undefined;
    const openAttachment = (rowId: string, a: Attachment) => { post({ t: 'open-attachment', id: sessionId, attachmentId: a.id, itemId: rowId }); };
    const step = (delta: 1 | -1) => { setAttachCursor(undefined); setCursorId((prev) => {
      const at = prev === undefined ? -1 : rows.findIndex((r) => r.id === prev);
      const next = delta === 1 ? Math.min(at + 1, rows.length - 1) : at < 0 ? rows.length - 1 : Math.max(at - 1, 0);
      return rows[next]?.id ?? prev;
    }); };
    if (action.do === 'item-next') { step(1); }
    else if (action.do === 'item-prev') { step(-1); }
    else if (action.do === 'page-up') { box?.scrollBy(-0.5, 'viewport'); }
    else if (action.do === 'page-down') { box?.scrollBy(0.5, 'viewport'); }
    else if (action.do === 'attachment-next' || action.do === 'attachment-prev') {
      if (!current || !sent) { return; }
      const at = attachCursor?.rowId === current.id ? attachCursor.index : -1;
      const next = action.do === 'attachment-next' ? Math.min(at + 1, sent.length - 1) : at - 1;
      setAttachCursor(next < 0 ? undefined : { rowId: current.id, index: next });
    }
    else if (action.do === 'toggle-item') {
      const highlighted = attachCursor?.rowId === current?.id ? sent?.[attachCursor?.index ?? -1] : undefined;
      const picked = highlighted ?? sent?.[0];
      if (current && picked) { openAttachment(current.id, picked); } else { toggleRow(current); }
    }
    else if (action.do === 'fork-item') {
      const row = rows[cursor];
      const owner = pane?.summary.owner;
      if (!row) { return; }
      if (pane?.summary.kind === 'side') { setNotice('Promote this side chat before forking it'); return; }
      if (owner) { setNotice(`Cannot fork "${pane.summary.name || pane.summary.title}": owned by ${owner.host}`); return; }
      onFork?.(row.id);
    }
    else if (action.do === 'promote-item') {
      const tool = current?.kind === 'tool' ? current.item.tool : undefined;
      if (tool?.kind === 'subagent' && tool.childSessionId) { post({ t: 'promote-subagent', id: tool.childSessionId }); }
      else { setNotice('Select a hosted subagent card to open it as a session'); }
    }
    else if (action.do === 'stop-item' || action.do === 'message-item') {
      const worker = hostedWorker(current);
      const owner = pane?.summary.owner;
      if (!worker) { setNotice('Select a hosted worker to stop or message it'); return; }
      if (owner) { setNotice(`Cannot reach this worker: "${pane.summary.name || pane.summary.title}" is owned by ${owner.host}`); return; }
      const live = worker.item.state === 'running';
      if (action.do === 'stop-item') {
        if (!live) { setNotice('This worker is not running'); return; }
        post({ t: 'interrupt', id: worker.id });
      } else {
        setWorkerTarget({ paneId: sessionId, workerId: worker.id, name: subagentLabel(worker.item), running: live });
      }
    }
    else if (action.do === 'repin') { setCursorId(undefined); box?.scrollTo(Number.MAX_SAFE_INTEGER); }
    if (action.do === 'page-up' || action.do === 'item-prev') { setTimeout(askOlder, 0); }
  });

  const theme = useTheme();
  const gaps = useTranscriptGaps();
  const muted = theme.colors.mutedForeground;
  return (
    <scrollbox ref={scroll} flexGrow={1} stickyScroll stickyStart="bottom" viewportCulling focused={focused}>
      {hasMore ? <text fg={muted}>↑ older messages</text> : null}
      {rows.map((row, i) => {
        const selected = focused && i === cursor;
        const opened = row.kind === 'workers' ? teamOpen(row.id, row.items)
          : row.kind === 'tool' && row.userShell ? !open.has(row.id) : open.has(row.id);
        return (
          <box
            key={row.id}
            id={row.id}
            flexDirection="column"
            marginBottom={gapAfter(row, rows[i + 1], opened, gaps)}
            border={['left']}
            customBorderChars={selected ? BAR_CHARS : GUTTER_CHARS}
            borderColor={theme.colors.primary}
            paddingLeft={1}
            onMouseDown={() => { setCursorId(row.id); toggleRow(row); }}
          >
            <RowView row={row} selected={selected} attachmentCursor={attachCursor?.rowId === row.id ? attachCursor.index : undefined} onOpenAttachment={(a) => { post({ t: 'open-attachment', id: sessionId, attachmentId: a.id, itemId: row.id }); }} expanded={row.kind === 'workers' ? opened : open.has(row.id)} closed={closed.has(row.id)} relocationKeys={relocationKeys} />
          </box>
        );
      })}
    </scrollbox>
  );
}
