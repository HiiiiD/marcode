import { LogInIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AttachmentChip } from './attachment-chips';
import { EditorContextChip } from './editor-context-chip';
import { Markdown } from './markdown';
import { PermissionCard } from './permission-card';
import { QuestionCard } from './question-card';
import { ReasoningBlock } from './reasoning-block';
import { RelocationCard } from './relocation-card';
import { SubagentCard } from './subagent-card';
import { ToolCard } from './tool-card';
import { TranscriptItemShell } from './transcript-item-shell';
import { isSignInFailure } from '../lib/provider-login';
import { useStore } from '../store';
import type { FileRef, SessionId, SessionRef, TranscriptItem } from '../../protocol/messages';

/**
 * "Fork from here" is offered only on the roles `buildSeed` actually turns
 * into seed lines — a permission/question/relocation/error/switch item is UI
 * chrome, not conversation content, and forking "from" one would branch at a
 * point the new session's provider thread never learns happened.
 */
const FORKABLE_ROLES: ReadonlySet<TranscriptItem['role']> = new Set(['user', 'assistant', 'tool']);

export function TranscriptItemView({
  item, sessionId,
}: {
  item: TranscriptItem;
  sessionId: SessionId;
}) {
  const { post, state } = useStore();
  // Gated on the whole session being idle, not on which turn this item
  // belongs to: a live turn can leave a dangling unanswered tool call or
  // permission past any item in it, and telling those apart per-item is not
  // worth the complexity a coarse "not mid-turn" gate avoids entirely.
  const canFork = FORKABLE_ROLES.has(item.role)
    && state.byId[sessionId]?.summary.status === 'idle';
  const onFork = canFork
    ? () => post({ t: 'fork-session', id: sessionId, itemId: item.id })
    : undefined;

  switch (item.role) {
    case 'user':
      return <UserItem item={item} onFork={onFork} />;

    case 'assistant':
      return (
        <TranscriptItemShell role="assistant" label="Agent" ts={item.ts} onFork={onFork}>
          {item.thinking && <ReasoningBlock text={item.thinking} />}
          <Markdown>{item.text}</Markdown>
        </TranscriptItemShell>
      );

    case 'tool':
      // What the call IS, not what it has produced yet. A tool item only
      // grows `children` once its subagent does something, so routing on
      // children alone rendered a just-spawned Task as a generic tool card —
      // precisely the window where the header's jump-to badge points at it
      // and the user needs the destination to look like what was promised.
      // `children` still routes on its own, so a provider that nests under a
      // call we do not classify as a subagent keeps its nested rendering.
      return item.tool.kind === 'subagent' || (item.children && item.children.length > 0)
        ? <SubagentCard item={item} sessionId={sessionId} />
        : <ToolCard item={item} onFork={onFork} />;

    case 'error': {
      // Only offered when the message reads as a sign-in failure (see
      // isSignInFailure) — a dead binary or an unrecognized failure would
      // not be fixed by a login terminal. The provider to sign in to is the
      // session's own, not parsed back out of the message text.
      const providerId = state.byId[sessionId]?.summary.providerId;
      return (
        <TranscriptItemShell role="error" label="Error" ts={item.ts}>
          <div className="max-h-48 overflow-auto rounded border border-destructive px-2 py-1 text-xs wrap-break-word whitespace-pre-wrap text-destructive">
            {item.message}
          </div>
          {isSignInFailure(item.message) && providerId !== undefined && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1.5"
              onClick={() => post({ t: 'login-provider', providerId })}
            >
              <LogInIcon aria-hidden />
              Log in
            </Button>
          )}
        </TranscriptItemShell>
      );
    }

    case 'permission':
      return <PermissionCard item={item} sessionId={sessionId} />;

    case 'question':
      return <QuestionCard item={item} sessionId={sessionId} />;

    case 'relocation':
      return <RelocationCard item={item} sessionId={sessionId} />;

    case 'switch': {
      const label = item.kind === 'model' ? 'Model' : item.kind === 'effort' ? 'Effort' : 'Worktree';
      return (
        <TranscriptItemShell role="tool" label={label} ts={item.ts}>
          <div className="text-xs text-muted-foreground">{item.text}</div>
        </TranscriptItemShell>
      );
    }

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

function UserItem({
  item, onFork,
}: {
  item: Extract<TranscriptItem, { role: 'user' }>;
  onFork?: () => void;
}) {
  const { post } = useStore();
  const ctx = item.context;
  // The item's `text` is the composed prompt, blocks included — it has to be,
  // since it is exactly what the provider received. For display the blocks are
  // lifted back out and shown as collapsed chips, so a handoff — or an
  // `@file` mention — reads as one sentence plus a source rather than as a
  // wall of somebody else's output.
  const { prose, blocks } = splitComposed(item.text, item.refs ?? [], item.fileRefs ?? []);

  return (
    <TranscriptItemShell role="user" label="You" ts={item.ts} onFork={onFork}>
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
      {item.attachments && item.attachments.length > 0 && (
        // Below the prose, unlike the editor-context chip above it: context is
        // what the message was about, attachments are what it shipped with.
        // Read-only — a sent turn is a record, so no chip offers removal.
        <ul aria-label="Attachments sent" className="mt-1 flex min-w-0 flex-wrap gap-1">
          {item.attachments.map((attachment) => (
            <li key={attachment.id}>
              <AttachmentChip attachment={attachment} />
            </li>
          ))}
        </ul>
      )}
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
 * Keyed off `refs`/`fileRefs` rather than pattern-matching every `---`
 * line: a user whose own prose contains a matching line must not have it
 * swallowed, and the refs say exactly which headings to look for. File
 * mentions use the same `--- file from <path> ---` heading `composePrompt`
 * gives `resolveFileRefs`'s blocks — see `session-refs.ts`.
 */
function splitComposed(text: string, refs: SessionRef[], fileRefs: FileRef[]): {
  prose: string;
  blocks: { heading: string; text: string }[];
} {
  const headings = [
    ...refs.map((ref) => `${ref.kind} from ${ref.title}`),
    ...fileRefs.map((ref) => `file from ${ref.path}`),
  ];
  const blocks: { heading: string; text: string }[] = [];
  let prose = text;

  for (const heading of headings) {
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
