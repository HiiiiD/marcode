import { useState } from 'react';
import { SendHorizontal, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { EffortLevel, ModelInfo, PermissionMode } from '../../protocol/messages';

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'ask',
  acceptEdits: 'auto-edits',
  plan: 'plan',
  dontAsk: 'deny',
  bypass: 'bypass',
};

/**
 * The `items` prop is what lets the trigger render the *label* of the selected
 * option. Without it Base UI's SelectValue falls back to the raw value, so the
 * trigger would read "acceptEdits" rather than "auto-edits".
 */
const MODE_ITEMS = (Object.keys(MODE_LABEL) as PermissionMode[])
  .map((value) => ({ value, label: MODE_LABEL[value] }));

export function Composer({ pane, model }: { pane: PaneState; model: ModelInfo | undefined }) {
  const { post } = useStore();
  const [text, setText] = useState('');
  const running = pane.summary.status === 'running'
    || pane.summary.status === 'awaiting-approval';
  const bypassing = pane.summary.permissionMode === 'bypass';
  /**
   * The Claude provider can only honor 'bypass' at query construction —
   * which now happens lazily, on the session's first send() — so this must
   * track the same "has a first message been sent yet" condition the
   * provider itself uses, not an approximation of it. `pane.items` is the
   * session's transcript; AgentSession.send() always appends a user item
   * before ever calling the provider, so "any items" and "sent the first
   * message" are the same fact told from two sides of the wire.
   */
  const hasStarted = pane.items.length > 0;
  // Session-scoped, not a bare literal: Composer renders once per pane, so a
  // fixed id would collide across panes — `getElementById`, which is what
  // `aria-describedby` resolves against, returns only the first match, and
  // every other pane's disabled bypass option would describe itself using
  // pane one's reason text.
  const bypassReasonId = `bypass-reason-${pane.summary.id}`;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) { return; }
    post({ t: 'send', id: pane.summary.id, text: trimmed });
    setText('');
  };

  return (
    <div className="p-2">
      <InputGroup>
        <InputGroupTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) { submit(); }
            }
          }}
          placeholder="Message the agent…"
          aria-label="Message"
        />
        {/*
          flex-wrap: at pane widths around 300px the effort trigger (w-24),
          the permission-mode trigger (w-28) and one or two buttons cannot
          share a single row with any breathing room. Wrapping lets settings
          fall to a second line rather than shrinking the triggers (their
          labels — "medium", "auto-edits" — are already tight) or hiding
          overflow behind a horizontal scrollbar a narrow split-pane user is
          unlikely to notice. Each wrapped line keeps its own `ml-auto`
          grouping, so the action button still lands at the right edge of
          whichever line it wraps to.
        */}
        <InputGroupAddon align="block-end" className="flex-wrap">
          {model?.effort && (
            <Select
              items={model.effort.levels.map((level) => ({ value: level, label: level }))}
              value={pane.summary.effort ?? model.effort.default}
              onValueChange={(value) => post({
                t: 'set-effort', id: pane.summary.id, effort: value as EffortLevel,
              })}
            >
              <SelectTrigger size="sm" className="w-24 border-0" aria-label="Effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {model.effort.levels.map((level) => (
                  <SelectItem key={level} value={level}>{level}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select
            items={MODE_ITEMS}
            value={pane.summary.permissionMode}
            onValueChange={(value) => post({
              t: 'set-permission-mode', id: pane.summary.id, mode: value as PermissionMode,
            })}
          >
            <SelectTrigger
              size="sm"
              className={cn(
                'w-28 border-0',
                bypassing && 'border border-destructive text-destructive dark:border-destructive/50',
              )}
              aria-label="Permission mode"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_ITEMS.map((item) => {
                const disableBypass = item.value === 'bypass' && hasStarted;
                return (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={disableBypass}
                    // Disabled-with-a-reason, not a silently-absent option —
                    // a user who used bypass earlier in this same session
                    // should be able to tell why it is greyed out now rather
                    // than wonder if it vanished. `aria-describedby` pointing
                    // at real, rendered text rather than a `title`: a title
                    // on a disabled control is reachable by neither keyboard
                    // focus nor most screen readers, since disabled elements
                    // are pulled out of both.
                    aria-describedby={disableBypass ? bypassReasonId : undefined}
                  >
                    {item.label}
                  </SelectItem>
                );
              })}
              {hasStarted && (
                <p id={bypassReasonId} className="px-1.5 py-1 text-[0.65rem] text-muted-foreground">
                  Bypass can only be chosen before the first message is sent.
                </p>
              )}
            </SelectContent>
          </Select>

          {running && (
            <Button
              variant="outline"
              size="icon-xs"
              className="ml-auto"
              onClick={() => post({ t: 'interrupt', id: pane.summary.id })}
              aria-label="Stop"
              title="Stop the agent"
            >
              <Square />
            </Button>
          )}
          <Button
            size="icon-xs"
            className={cn(!running && 'ml-auto')}
            onClick={submit}
            // Disabled-with-a-reason rather than unmounted: swapping Send out
            // for Stop makes the row jump and leaves a user who has typed the
            // next instruction with no explanation of where Send went.
            disabled={running || !text.trim()}
            aria-label="Send"
            // Icon-only control: the hover title is a discoverability aid for
            // sighted mouse/keyboard users, not the accessible name (that's
            // aria-label above). Only set while enabled — a title on a
            // disabled element is unreliable for assistive tech, so the
            // disabled state gets its explanatory reason instead.
            title={running
              ? 'The agent is working. Stop it to send another message.'
              : 'Send message'}
          >
            <SendHorizontal />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
