import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EditorContextLabel, chipLabel, contextTitle } from './editor-context-chip';
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
 * how much room this control actually has. The accessible name carries the
 * file either way, so collapsing to the icon costs nothing to a screen
 * reader.
 */
export function EditorContextToggle({ pane }: { pane: PaneState }) {
  const { state, post } = useStore();
  const ctx = state.editorContext;
  if (!ctx) { return null; }

  const on = pane.summary.includeEditorContext;
  // The full path, not `chipLabel` — the accessible name identifies which
  // file, and a bare basename would collide across same-named files in
  // different folders. No literal colon in the sentence itself: any colon
  // that shows up must come from a line span the file actually carries, not
  // from punctuation glued on here, so the no-selection case reads as one
  // colon-free sentence.
  const verb = on ? 'Attaching' : 'Not attaching';

  return (
    <Button
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={on}
      aria-label={`${verb} editor context ${ctx.path}`}
      title={`${verb} ${contextTitle(ctx)}`}
      onClick={() => post({ t: 'set-include-context', id: pane.summary.id, on: !on })}
      className={cn('min-w-0 max-w-56', !on && 'text-muted-foreground')}
    >
      <Paperclip aria-hidden="true" />
      <EditorContextLabel ctx={ctx} className="hidden @[17rem]:flex" />
      <span className="sr-only">{chipLabel(ctx)}</span>
    </Button>
  );
}
