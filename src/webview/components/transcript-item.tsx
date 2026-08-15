import { useState } from 'react';
import { EditorContextChip } from './editor-context-chip';
import { Markdown } from './markdown';
import { PermissionCard } from './permission-card';
import { ReasoningBlock } from './reasoning-block';
import { RelocationCard } from './relocation-card';
import { SubagentCard } from './subagent-card';
import { ToolCard } from './tool-card';
import { TranscriptItemShell } from './transcript-item-shell';
import { useStore } from '../store';
import type { SessionId, SessionRef, TranscriptItem } from '../../protocol/messages';

export function TranscriptItemView({
  item, sessionId,
}: {
  item: TranscriptItem;
  sessionId: SessionId;
}) {
  switch (item.role) {
    case 'user':
      return <UserItem item={item} />;

    case 'assistant':
      return (
        <TranscriptItemShell role="assistant" label="Agent" ts={item.ts}>
          {item.thinking && <ReasoningBlock text={item.thinking} />}
          <Markdown>{item.text}</Markdown>
        </TranscriptItemShell>
      );

    case 'tool':
      // A tool item only grows `children` once its subagent actually does
      // something, so a Task that ran nothing renders as an ordinary tool
      // card — correct, since there is nothing nested to show.
      return item.children && item.children.length > 0
        ? <SubagentCard item={item} sessionId={sessionId} />
        : <ToolCard item={item} />;

    case 'error':
      return (
        <TranscriptItemShell role="error" label="Error" ts={item.ts}>
          <div className="max-h-48 overflow-auto rounded border border-destructive px-2 py-1 text-xs wrap-break-word whitespace-pre-wrap text-destructive">
            {item.message}
          </div>
        </TranscriptItemShell>
      );

    case 'permission':
      return <PermissionCard item={item} sessionId={sessionId} />;

    case 'relocation':
      return <RelocationCard item={item} sessionId={sessionId} />;

    default:
      // The TranscriptItem type is closed, but nothing guarantees a runtime
      // value matches it (schema drift between an older webview bundle and a
      // newer host, or corrupted persisted transcript data). Render an
      // unobtrusive placeholder rather than falling off the switch and
      // returning undefined, which React treats as a render error and would
      // unmount the whole transcript.
      return (
        <div className="my-0 text-xs text-muted-foreground">Unsupported item</div>
      );
  }
}

function UserItem({ item }: { item: Extract<TranscriptItem, { role: 'user' }> }) {
  const { post } = useStore();
  const ctx = item.context;
  // The item's `text` is the composed prompt, blocks included — it has to be,
  // since it is exactly what the provider received. For display the blocks are
  // lifted back out and shown as collapsed chips, so a handoff reads as one
  // sentence plus a source rather than as a wall of somebody else's output.
  const { prose, blocks } = splitComposed(item.text, item.refs ?? []);

  return (
    <TranscriptItemShell role="user" label="You" ts={item.ts}>
      {ctx && (
        <div className="mb-1 flex">
          <EditorContextChip
            ctx={ctx}
            onClick={() => post({
              t: 'reveal-file',
              path: ctx.path,
              startLine: ctx.selection?.ranges[0]?.startLine,
            })}
          />
        </div>
      )}
      {/* No inner box: the shell's own filled block is what marks this as the
          user's turn. A second surface inside it was a nested card that read
          as a shade of nothing. */}
      <div className="wrap-break-word whitespace-pre-wrap">
        {prose}
      </div>
      {blocks.map((block, i) => (
        // Positional, not the heading alone: a heading is `kind from title`
        // and every session starts titled `Untitled`, so two references to
        // same-kind sources collide on a heading-only key — React warns, and
        // `SourceBlock`'s open state can reconcile onto the wrong block.
        <SourceBlock key={`${i}-${block.heading}`} heading={block.heading} text={block.text} />
      ))}
    </TranscriptItemShell>
  );
}

/**
 * `<details>`/`<summary>` are the one exception the shadcn rule doesn't
 * cover — disclosure semantics, not a control, with no vendored equivalent.
 * The payload is only mounted once opened, so a still-collapsed chip never
 * puts thousands of lines of somebody else's output in the DOM.
 *
 * `open` is controlled from React state rather than left to the browser's
 * own toggling: a browser fires `toggle` as a queued task, one tick after
 * the click that caused it, so a handler hung off `onToggle` mounts the
 * payload a beat late. Handling the summary's `click` directly — and
 * preventing its default action, since that default *is* the native
 * toggle — keeps the open/closed state and the mount happening in the same
 * update, with the same keyboard and screen-reader behaviour a native
 * `<details>` gives for free (summary is a default button-role element, so
 * Enter/Space already dispatch `click`).
 */
function SourceBlock({ heading, text }: { heading: string; text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <details className="mt-1.5" open={open}>
      <summary
        className="cursor-pointer text-xs text-muted-foreground"
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        {heading}
      </summary>
      {open && (
        <div className="mt-1 wrap-break-word whitespace-pre-wrap text-xs text-muted-foreground">
          {text}
        </div>
      )}
    </details>
  );
}

/**
 * Lifts the fenced blocks `composePrompt` appended back out of the text.
 *
 * Keyed off `refs` rather than pattern-matching every `---` line: a user whose
 * own prose contains a matching line must not have it swallowed, and the refs
 * say exactly which headings to look for.
 */
function splitComposed(text: string, refs: SessionRef[]): {
  prose: string;
  blocks: { heading: string; text: string }[];
} {
  const blocks: { heading: string; text: string }[] = [];
  let prose = text;

  for (const ref of refs) {
    const heading = `${ref.kind} from ${ref.title}`;
    const open = `--- ${heading} ---\n`;
    const close = `\n--- end ${heading} ---`;
    const start = prose.indexOf(open);
    if (start < 0) { continue; }
    const end = prose.indexOf(close, start);
    if (end < 0) { continue; }
    blocks.push({ heading, text: prose.slice(start + open.length, end) });
    prose = (prose.slice(0, start) + prose.slice(end + close.length)).trimEnd();
  }

  return { prose, blocks };
}
