import { createContext, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import {
  choiceFromKey, initialChoice, moveDialogView, moveMessage, type MoveChoice,
} from '../client-core/sync/move-dialog';
import type { SessionId } from '../protocol/messages';
import { useStore } from './store';

/** Opens the move dialog for a row; provided by the app, used by each remote row's "Move here…". */
export const MoveRequest = createContext<(id: SessionId) => void>(() => {});

export function MoveDialog({ id, onClose }: { id: SessionId | null; onClose(): void }) {
  const { state, post } = useStore();
  const slice = state.move?.id === id ? state.move : undefined;
  const session = state.sessions.find((s) => s.id === id);
  const [choice, setChoice] = useState<MoveChoice>({ cancelTurn: false });
  const panel = slice?.panel;
  useEffect(() => { if (panel) { setChoice(initialChoice(panel)); } }, [panel]);
  const status = slice?.status;
  useEffect(() => {
    if (id && status?.state === 'done') {
      post({ t: 'focus-session', id: status.sessionId });
      onClose();
    }
  }, [status]);

  const name = session?.name ?? '';
  const running = session?.status === 'running' || session?.status === 'awaiting-approval';
  const view = panel ? moveDialogView({ panel, status, choice, name, running }) : undefined;

  const action = useRef<HTMLButtonElement>(null);
  const locked = view?.action.disabled === true;

  const act = () => {
    if (!panel || !view || view.action.kind === 'close') { onClose(); return; }
    const msg = moveMessage(panel, choice);
    if (msg) { post(msg); }
  };

  return (
    <Dialog open={id !== null} onOpenChange={(open) => { if (!open) { onClose(); } }}>
      <DialogContent initialFocus={action} className="flex max-h-[calc(100dvh-4rem)] flex-col gap-3 text-sm sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{view?.title ?? `Move "${name}" here`}</DialogTitle>
        </DialogHeader>
        {!view && <p className="text-xs text-muted-foreground">Checking where it can go…</p>}
        {view && view.options.length > 0 && (
          <RadioGroup
            className="max-h-64 scroll-pb-2 gap-1 overflow-y-auto"
            aria-label="Checkout"
            value={view.selected ?? null}
            onValueChange={(key) => { setChoice(choiceFromKey(String(key), choice.cancelTurn)); }}
          >
            {view.options.map((o) => (
              <label key={o.key} className={cn('flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted', locked && 'cursor-default opacity-60')}>
                <RadioGroupItem className="mt-0.5" value={o.key} aria-label={o.label} disabled={view.action.disabled} />
                <span className="min-w-0">
                  <span className="line-clamp-2 break-words">{o.label}</span>
                  {o.detail && <span className="line-clamp-2 break-all text-xs text-muted-foreground">{o.detail}</span>}
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
        {view?.lines.map((line) => <p key={line} className="text-xs text-muted-foreground">{line}</p>)}
        {view?.checkbox && (
          <label className={cn('flex items-center gap-2 text-xs', locked && 'opacity-60')}>
            <Checkbox
              checked={choice.cancelTurn}
              disabled={view.action.disabled}
              onCheckedChange={(v) => { setChoice({ ...choice, cancelTurn: v === true }); }}
              aria-label={view.checkbox}
            />
            {view.checkbox}
          </label>
        )}
        {view?.progress && <p className="text-xs text-muted-foreground" aria-live="polite">{view.progress}</p>}
        {view?.error && <p className="text-xs text-destructive" role="alert">{view.error}</p>}
        {/* A plain column when stacked: the shadcn footer's reversed column draws the primary above the button Tab reaches first. */}
        <DialogFooter className="flex-col sm:flex-row sm:justify-end">
          {view && view.action.kind !== 'close' && (
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          )}
          <Button ref={action} size="sm" disabled={view?.action.disabled ?? true} onClick={act}>
            {view?.action.label ?? 'Move here'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
