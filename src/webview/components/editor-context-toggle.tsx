import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EditorContextLabel, contextTitle, lineSpan } from './editor-context-chip';
import { useStore } from '../store';
import type { PaneState } from '../reducer';

/**
 * Attach-or-not for the next message, and a preview of what would be
 * attached.
 *
 * Renders nothing when there is no editor: a disabled control in a 300px
 * sidebar is a dead affordance, and the absence is unambiguous because the
 * control only ever exists when there is something to attach.
 *
 * The label is revealed by a container query rather than a viewport one —
 * a pane can be half the sidebar, so the viewport says nothing useful about
 * how much room this control actually has. The accessible name (`aria-label`,
 * built from the same path and line span the visible label renders) carries
 * both the file and the line span either way, so collapsing the visible
 * label to the icon costs nothing to a screen reader.
 */
export function EditorContextToggle({ pane }: { pane: PaneState }) {
  const { state, post } = useStore();
  const ctx = state.editorContext;
  if (!ctx) { return null; }

  const on = pane.summary.includeEditorContext;
  // The full path, not the basename — the accessible name identifies which
  // file, and a bare basename would collide across same-named files in
  // different folders. `lineSpan` supplies its own leading colon, and only
  // when there is a real selection to report, so the no-selection case
  // still reads as one colon-free sentence without any punctuation glued on
  // here.
  const verb = on ? 'Attaching' : 'Not attaching';

  return (
    <Button
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={on}
      aria-label={`${verb} editor context ${ctx.path}${lineSpan(ctx)}`}
      title={`${verb} ${contextTitle(ctx)}`}
      onClick={() => post({ t: 'set-include-context', id: pane.summary.id, on: !on })}
      className={cn('min-w-0 max-w-56', !on && 'text-muted-foreground')}
    >
      <Paperclip aria-hidden="true" />
      <EditorContextLabel ctx={ctx} className="hidden @[17rem]:flex" />
    </Button>
  );
}
