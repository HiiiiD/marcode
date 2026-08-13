import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
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

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) { return; }
    post({ t: 'send', id: pane.summary.id, text: trimmed });
    setText('');
  };

  return (
    <div className="border-t border-border p-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        placeholder="Message the agent…"
        aria-label="Message"
        className="resize-none text-sm"
      />
      <div className="mt-1 flex items-center gap-2 text-xs">
        {running ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => post({ t: 'interrupt', id: pane.summary.id })}
          >
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={!text.trim()}>Send</Button>
        )}

        {model?.effort && (
          <Select
            items={model.effort.levels.map((level) => ({ value: level, label: level }))}
            value={pane.summary.effort ?? model.effort.default}
            onValueChange={(value) => post({
              t: 'set-effort', id: pane.summary.id, effort: value as EffortLevel,
            })}
          >
            <SelectTrigger size="sm" className="w-24" aria-label="Effort">
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
              'w-28',
              bypassing && 'border-destructive text-destructive dark:border-destructive/50',
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
                  // Disabled-with-a-reason: a native tooltip, not a
                  // silently-absent option — a user who used bypass earlier
                  // in this same session should be able to tell why it is
                  // greyed out now rather than wonder if it vanished.
                  title={disableBypass
                    ? 'Bypass can only be chosen before the first message is sent'
                    : undefined}
                >
                  {item.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
