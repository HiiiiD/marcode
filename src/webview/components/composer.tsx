import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SendHorizontal, Square, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import type { Invocable, ModelInfo } from "../../protocol/messages";
import { interceptFor } from "../lib/intercepts";
import { insertionFor, menuKeyAction, menuQuery, menuView, nextIndex } from "../lib/invocable-menu";
import {
  filterMentions, mentionQuery, pruneMentions, spliceMention, tokenFor,
  type MentionOption, type PendingMention,
} from "../lib/mention-menu";
import {
  sessionMentions, sessionRefsOf, type SessionMentionPayload,
} from "../lib/session-mentions";
import type { PaneState } from "../reducer";
import { useStore } from "../store";
import { ContextRing } from "./context-ring";
import { EditorContextToggle } from "./editor-context-toggle";
import { InvocableMenu } from "./invocable-menu";
import { ModeMenu } from "./mode-menu";
import { RefMenu } from "./ref-menu";

export function Composer({
  pane,
  model,
  models,
  unavailableReason,
}: {
  pane: PaneState;
  model: ModelInfo | undefined;
  models: ModelInfo[];
  /**
   * Set when this session's provider cannot be run — see
   * `lib/provider-availability.ts`. The composer goes read-only and says so,
   * rather than accepting a message the host would refuse. The transcript
   * above it keeps rendering: the work is still worth reading, and the
   * session comes back the moment the provider does.
   */
  unavailableReason?: string;
}) {
  const { state, post } = useStore();
  const [text, setText] = useState("");
  /** The selected entry's arg hint. Presentation only; never sent. */
  const [ghost, setGhost] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * Escape, or focus leaving the box, closed the menu. Only a fresh keystroke
   * or the control reopens it — otherwise a user who dismissed the list would
   * have it spring back on the next render.
   */
  const [dismissed, setDismissed] = useState(false);
  const [refs, setRefs] = useState<PendingMention<SessionMentionPayload>[]>([]);
  const [caret, setCaret] = useState(0);
  const [refDismissed, setRefDismissed] = useState(false);
  // `setHandoffOpen` arrives in Task 7's dialog; declared now so `pickRef`'s
  // action branch has somewhere to signal it opened.
  const [handoffOpen, setHandoffOpen] = useState(false);
  /**
   * The context dialog has two doors — the ring beside the Send button and
   * an intercepted `/context` — so its open state lives here, above both,
   * rather than inside the ring.
   */
  const [contextOpen, setContextOpen] = useState(false);
  // The control has to hand focus back to the box: every key the menu answers
  // to is bound on the textarea, so a menu opened by a click that left focus
  // on the button would be unreachable by keyboard.
  const box = useRef<HTMLTextAreaElement | null>(null);
  const running = pane.summary.status === "running" || pane.summary.status === "awaiting-approval";
  // Session-scoped, not a bare literal: Composer renders once per pane, so a
  // fixed id would collide across panes — `getElementById`, which is what
  // `aria-describedby` resolves against, returns only the first match, and
  // every other pane's disabled control would describe itself using pane
  // one's reason text. Same rationale for every `*ReasonId` below.
  const sendReasonId = `send-reason-${pane.summary.id}`;
  // One id for every control this state disables, session-scoped like the
  // rest: the reason is one visible line, so each disabled control points at
  // the same sentence rather than repeating it sr-only per control.
  const unavailableReasonId = `provider-reason-${pane.summary.id}`;
  const readOnly = unavailableReason !== undefined;
  // Same session-scoping rationale again, for the `/` control's
  // disabled-over-a-draft reason.
  const invocablesReasonId = `invocables-reason-${pane.summary.id}`;

  const entries = pane.invocables ?? [];
  /**
   * Two entry points, ONE state machine. The control does not have an
   * "opened by click" flag of its own — it types the `/` for the user and
   * hands focus back, so from here on the click path and the typed path are
   * indistinguishable. A separate flag was the earlier shape and it made the
   * clicked menu keyboard-dead and closed it on the first character typed.
   */
  const query = menuQuery(text);
  const menuOpen = entries.length > 0 && query !== undefined && !dismissed;
  const view = menuOpen ? menuView(entries, query ?? "") : { rows: [], overflow: 0 };
  const index = Math.min(activeIndex, Math.max(0, view.rows.length - 1));
  // Session-scoped for the same reason as bypassReasonId above: one Composer
  // renders per pane, and `aria-activedescendant` resolves ids document-wide.
  const menuListId = `invocables-${pane.summary.id}`;
  // The id goes on the TEXTAREA, which is where focus actually is. ARIA only
  // honours `aria-activedescendant` on the focused element, so a copy on the
  // listbox alone announces nothing. Undefined while the `No match` row shows:
  // that row is deliberately not addressable, so there is no id to point at.
  const activeOptionId = menuOpen && view.rows.length > 0 ? `${menuListId}-${index}` : undefined;
  // Trigger discipline puts the menu at position 0 only, so it genuinely
  // cannot open over a half-written message. Disabled-with-a-reason rather
  // than silently clearing the draft — the earlier shape reset the box, which
  // threw away work — and rather than hiding, which leaves the control
  // flickering in and out of a row that already wraps.
  const menuBlocked = text.trim().length > 0;

  const refHit = refDismissed ? undefined : mentionQuery(text, caret);
  // One array per source, concatenated. File tagging arrives as one more
  // source here and changes nothing else.
  const refRows = refHit
    ? filterMentions(sessionMentions(state.sessions, pane.summary.id), refHit.query)
    : [];
  // The two menus never share the screen: `/` only triggers on an empty box at
  // position 0, `@` only on a word boundary, and `menuOpen` wins if both ever
  // manage to be true.
  const refOpen = refHit !== undefined && !menuOpen;
  const refListId = `session-refs-${pane.summary.id}`;
  const refIndex = Math.min(activeIndex, Math.max(0, refRows.length - 1));
  // Same contract as activeOptionId above: the id goes on the TEXTAREA,
  // because ARIA only honours aria-activedescendant on the focused element,
  // and it is undefined when the list has no addressable row.
  const activeRefOptionId = refOpen && refRows.length > 0
    ? `${refListId}-${refIndex}`
    : undefined;

  const openMenu = () => {
    setText("/");
    setGhost("");
    setActiveIndex(0);
    setDismissed(false);
    box.current?.focus();
  };

  const pick = (entry: Invocable) => {
    const { text: next, ghost: hint } = insertionFor(entry);
    setText(next);
    setGhost(hint);
    setActiveIndex(0);
  };

  const pickRef = (option: MentionOption<SessionMentionPayload>) => {
    if (!refHit) { return; }
    if (option.payload.kind === 'action') {
      // An action row inserts no token: it opens a dialog instead of
      // referencing anything. Strip the query the user typed to get there.
      setText(spliceMention(text, refHit.start, caret, '').text);
      setHandoffOpen(true);
      setRefDismissed(true);
      return;
    }
    const token = tokenFor(option, refs.map((r) => r.token));
    const next = spliceMention(text, refHit.start, caret, token);
    setText(next.text);
    setCaret(next.caret);
    setRefs([...refs, { token, payload: option.payload }]);
    setActiveIndex(0);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    // A command the panel renders itself never reaches the agent: sending it
    // would print the same numbers as a wall of transcript text under the
    // dialog that already shows them. The box is still cleared, so the
    // command behaves like any other submission.
    const intercept = interceptFor(trimmed);
    if (intercept === "context") {
      setContextOpen(true);
    } else {
      // `ghost` is presentation only — the arg hint is never part of the message.
      const carried = sessionRefsOf(pruneMentions(trimmed, refs));
      post({
        t: "send", id: pane.summary.id, text: trimmed,
        ...(carried.length > 0 ? { refs: carried } : {}),
      });
    }
    setText("");
    setGhost("");
    setRefs([]);
    setDismissed(false);
    setRefDismissed(false);
  };

  return (
    <div className="@container p-2">
      {readOnly && (
        // Visible, not sr-only, unlike the other disabled-reasons in this
        // row: those explain a control the user can re-enable in a second
        // (stop the agent, clear the draft), while this one explains why the
        // whole composer is inert — with nothing on screen to infer it from.
        // It sits above the box so it reads before the dead controls, and the
        // icon keeps it legible when the sentence wraps at 300px.
        <p
          id={unavailableReasonId}
          className="mb-1.5 flex items-start gap-1.5 text-xs text-muted-foreground"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{unavailableReason}</span>
        </p>
      )}
      <InputGroup>
        {menuOpen && (
          // A block-start addon, not a popover: the list sits above the box in
          // normal flow, so there is no positioning maths, no portal, and
          // nothing to clip inside a narrow pane's scroll container.
          <InputGroupAddon align="block-start" className="p-1">
            <InvocableMenu
              rows={view.rows}
              overflow={view.overflow}
              activeIndex={index}
              listId={menuListId}
              onPick={pick}
            />
          </InputGroupAddon>
        )}
        {refOpen && (
          <InputGroupAddon align="block-start" className="p-1">
            <RefMenu
              rows={refRows}
              activeIndex={refIndex}
              listId={refListId}
              onPick={pickRef}
            />
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          ref={box}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setRefs((current) => pruneMentions(e.target.value, current));
            setGhost("");
            setActiveIndex(0);
            setDismissed(false);
            setRefDismissed(false);
          }}
          // Focus leaving the box closes the list. The menu is an in-flow
          // block-start addon, so left open it keeps eating vertical space
          // above the composer after the user has clicked away into the
          // transcript. This does not fight a mouse pick: the rows call
          // preventDefault on mousedown, so selecting one never blurs.
          onBlur={() => setDismissed(true)}
          onKeyDown={(e) => {
            // Only WHILE OPEN does the menu claim keys. `menuKeyAction`
            // decides which; anything it passes on falls through to the
            // composer's own Enter binding below, unchanged.
            // An IME composition-confirm keydown reports key === 'Enter' with
            // isComposing === true. That Enter belongs to the composition,
            // not the menu — claiming it here (Chromium fires it even though
            // the composer's own Enter binding below already guards on
            // isComposing) would insert a row instead of committing the IME
            // text, so it is treated as 'pass' regardless of what
            // menuKeyAction says.
            const composingEnter = e.key === "Enter" && e.nativeEvent.isComposing;
            if (refOpen && !composingEnter) {
              const action = menuKeyAction(e.key);
              if (action !== "pass") {
                e.preventDefault();
                if (action === "move-down") { setActiveIndex(nextIndex(refIndex, 1, refRows.length)); }
                if (action === "move-up") { setActiveIndex(nextIndex(refIndex, -1, refRows.length)); }
                if (action === "select" && refRows[refIndex]) { pickRef(refRows[refIndex]); }
                if (action === "close") { setRefDismissed(true); }
                return;
              }
            }
            if (menuOpen && !composingEnter) {
              const action = menuKeyAction(e.key);
              if (action !== "pass") {
                e.preventDefault();
                if (action === "move-down") {
                  setActiveIndex(nextIndex(index, 1, view.rows.length));
                }
                if (action === "move-up") {
                  setActiveIndex(nextIndex(index, -1, view.rows.length));
                }
                if (action === "select" && view.rows[index]) {
                  pick(view.rows[index]);
                }
                if (action === "close") {
                  setDismissed(true);
                }
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) {
                submit();
              }
            }
          }}
          placeholder="Message the agent…"
          aria-label="Message"
          disabled={readOnly}
          aria-describedby={readOnly ? unavailableReasonId : undefined}
          aria-controls={menuOpen ? menuListId : refOpen ? refListId : undefined}
          aria-expanded={menuOpen || refOpen}
          aria-activedescendant={activeOptionId ?? activeRefOptionId}
        />
        {/*
          flex-wrap: at pane widths around 300px the mode trigger, the model
          trigger and one or two buttons cannot share a single row with any
          breathing room. Wrapping lets settings fall to a second line rather
          than shrinking the triggers (their labels — "Auto-edit", a model
          name — are already tight) or hiding overflow behind a horizontal
          scrollbar a narrow split-pane user is unlikely to notice. Each
          wrapped line keeps its own `ml-auto`
          grouping, so the action button still lands at the right edge of
          whichever line it wraps to.
        */}
        <InputGroupAddon align="block-end" className="flex-wrap">
          {/*
            First in the row, ahead of the ghost hint, so the control keeps a
            fixed position: the hint is transient, and a control that slides
            sideways whenever an arg hint appears costs the user the muscle
            memory that makes an icon-only affordance usable at all. Icon
            scale, matching Stop and Send — a labelled button would push this
            wrapping row onto a third line at 300px.
          */}
          {entries.length > 0 && (
            <Button
              variant="outline"
              size="icon-xs"
              aria-label="Skills and commands"
              // Same disabled-with-a-reason contract as Send and the bypass
              // option: the explanation is real rendered text behind
              // `aria-describedby`, never a `title` — a title on a disabled
              // control is reachable by neither keyboard focus nor most
              // screen readers. The title stays purely a discoverability aid
              // for the enabled state.
              disabled={menuBlocked}
              aria-describedby={menuBlocked ? invocablesReasonId : undefined}
              title={menuBlocked ? undefined : "Skills and commands"}
              onClick={openMenu}
            >
              <span>/</span>
            </Button>
          )}
          {entries.length > 0 && menuBlocked && (
            // sr-only for the same reason as the Send reason below: this row
            // wraps at 300px already and has no room for a sentence, and the
            // control is visibly disabled.
            <span id={invocablesReasonId} className="sr-only">
              Clear the message to browse skills and commands.
            </span>
          )}
          {ghost && (
            // aria-hidden: it is a hint about what to type next, and the
            // textarea it annotates already holds the inserted name. A live
            // region here would announce the same thing twice.
            <span className="truncate text-xs text-muted-foreground" aria-hidden>
              {ghost}
            </span>
          )}
          <EditorContextToggle pane={pane} />
          {/* Permission mode and effort share one trigger: two adjacent
              word-labels spent a third of the row on jargon and still left
              the modes unexplained. See mode-menu.tsx. */}
          <ModeMenu pane={pane} model={model} disabled={readOnly} />

          <Select
            items={models.map((m) => ({ value: m.id, label: m.displayName }))}
            // The one case where the model control does freeze: with the
            // provider gone so is its catalog, so there is nothing to switch
            // to that the host could honor.
            disabled={readOnly}
            // The row's id, not the session's: a session persisted under a
            // wire id (`claude-opus-5`) is served by the alias row that
            // covers it (`opus`), and a value matching no item leaves the
            // trigger rendering the raw id instead of the label.
            value={model?.id ?? pane.summary.model}
            onValueChange={(value) => post({ t: "set-model", id: pane.summary.id, model: value as string })}
          >
            <SelectTrigger
              size="sm"
              className="min-w-0 shrink truncate ml-auto"
              aria-label="Model"
              // Never disabled. `Query.setModel` retargets the live session
              // (see claude-provider.ts), so a switch mid-conversation takes
              // effect on the next turn rather than being silently recorded —
              // there is nothing to freeze and no reason to explain — except
              // when the provider itself is unavailable, see `disabled` above.
              aria-describedby={readOnly ? unavailableReasonId : undefined}
              render={<Button variant={"outline"} />}
            >
              <SelectValue className="truncate" />
            </SelectTrigger>
            {/* The popup defaults to the trigger's width with the overflow
                hidden, and this trigger shrinks to fit a 300px sidebar — so
                a name like "Default (recommended)" gets cut mid-word. Size
                to the content instead, floored at the trigger and capped at
                what the viewport actually has. */}
            <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {running && (
            <Button
              variant="outline"
              size="icon-xs"
              onClick={() => post({ t: "interrupt", id: pane.summary.id })}
              aria-label="Stop"
              title="Stop the agent"
            >
              <Square />
            </Button>
          )}
          <Button
            size="icon-sm"
            onClick={submit}
            // Disabled-with-a-reason rather than unmounted: swapping Send out
            // for Stop makes the row jump and leaves a user who has typed the
            // next instruction with no explanation of where Send went.
            disabled={running || readOnly || !text.trim()}
            aria-label="Send"
            // Icon-only control: the hover title is a discoverability aid for
            // sighted mouse/keyboard users, not the accessible name (that's
            // aria-label above). There are two disabled states here, not
            // one — `running` and an empty box — so the title can't just key
            // off `running`: doing that left `title="Send message"` sitting
            // on a disabled, empty composer, which is actively misleading
            // since clicking does nothing. Set only when the button is
            // actually clickable; the running case gets its explanatory
            // reason via `aria-describedby` instead, matching the other
            // disabled-with-a-reason sites in this file and
            // session-header.tsx/session-picker.tsx — a `title` on a
            // disabled element is reachable by neither keyboard focus nor
            // most screen readers, since disabled elements are pulled out of
            // both.
            aria-describedby={readOnly ? unavailableReasonId : running ? sendReasonId : undefined}
            title={!running && text.trim() ? "Send message" : undefined}
          >
            <SendHorizontal />
          </Button>
          {running && (
            // sr-only rather than visible: the row has no room for a
            // sentence next to the settings and the Stop/Send buttons, and
            // Send is already visibly disabled.
            <span id={sendReasonId} className="sr-only">
              The agent is working. Stop it to send another message.
            </span>
          )}
          <ContextRing pane={pane} open={contextOpen} onOpenChange={setContextOpen} />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
