import {
  Fragment, useEffect, useRef, useState,
} from 'react';
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable';
// react-resizable-panels ships ESM-only; a type-only import from a CommonJS
// module needs an explicit resolution-mode attribute (TS 5.3+) or tsc's
// per-file CJS/ESM interop check rejects it outright (TS1541) — see the
// similar note on the value import in the vendored resizable.tsx.
import type { Layout } from 'react-resizable-panels' with { 'resolution-mode': 'import' };
import { SessionHeader } from './session-header';
import { Transcript } from './transcript';
import { Composer } from './composer';
import { visiblePanes } from './pane-layout';
import { useStore } from '../store';

const NARROW_PX = 500;

export function PaneGroup() {
  const { state, post } = useStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) { return; }
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < NARROW_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A pane can outlive `close-session`/`delete-session` on the client for a
  // render or two, and its stale `byId` entry is never cleaned up. Render
  // only sessions that are both eligible (still in the roster, not
  // archived) and have an arrived snapshot — see pane-layout.ts.
  const eligible = new Set(state.sessions.filter((s) => !s.archived).map((s) => s.id));
  const snapshotArrived = new Set(Object.keys(state.byId));
  const panes = visiblePanes(state.layout.panes, eligible, snapshotArrived);
  const orientation = narrow ? 'vertical' : state.layout.orientation;

  if (panes.length === 0) {
    return (
      <div ref={rootRef} className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        No open sessions.
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full">
      <ResizablePanelGroup
        orientation={orientation}
        aria-label="Open agent sessions"
        onLayoutChange={(layout: Layout) => post({
          t: 'set-layout',
          layout: {
            orientation: state.layout.orientation,
            panes: panes.map((p) => ({ sessionId: p.sessionId, size: layout[p.sessionId] ?? p.size })),
          },
        })}
      >
        {panes.map((pane, index) => {
          const paneState = state.byId[pane.sessionId];
          const provider = state.catalog.find((p) => p.id === paneState.summary.providerId);
          const model = provider?.models.find((m) => m.id === paneState.summary.model);
          return (
            <Fragment key={pane.sessionId}>
              {index > 0 && (
                <ResizableHandle aria-label={`Resize between panes ${index} and ${index + 1}`} withHandle />
              )}
              <ResizablePanel
                id={pane.sessionId}
                aria-label={`Session: ${paneState.summary.title}`}
                defaultSize={`${pane.size}%`}
                minSize="15%"
                collapsible
              >
                <div className="flex h-full flex-col">
                  <SessionHeader
                    key={paneState.summary.id}
                    pane={paneState}
                    models={provider?.models ?? []}
                  />
                  <div className="min-h-0 flex-1">
                    <Transcript
                      pane={paneState}
                      onLoadMore={(beforeItemId) => post({
                        t: 'load-more', id: pane.sessionId, beforeItemId,
                      })}
                    />
                  </div>
                  <Composer key={paneState.summary.id} pane={paneState} model={model} />
                </div>
              </ResizablePanel>
            </Fragment>
          );
        })}
      </ResizablePanelGroup>
    </div>
  );
}
