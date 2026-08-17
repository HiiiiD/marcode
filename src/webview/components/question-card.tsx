import { TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { useStore } from '../store';
import type {
  QuestionAnswers, QuestionOption, QuestionSpec, SessionId, TranscriptItem,
} from '../../protocol/messages';
import { Markdown } from './markdown';
import { TranscriptItemShell } from './transcript-item-shell';

type QuestionItem = Extract<TranscriptItem, { role: 'question' }>;

/**
 * A settled question reads as a sentence, never as the wire token. "Scope —
 * stale" is a state machine talking to itself; scrollback is read by a human
 * hours later who needs to know whether the agent got an answer.
 */
const SETTLED: Record<Exclude<QuestionItem['state'], 'pending'>, string> = {
  answered: 'Answered',
  cancelled: 'Turn stopped before answering',
  stale: 'Expired unanswered',
};

/**
 * An option's accessible name is label *and* description. The description is
 * not decoration here — it is the difference between the choices, so a name of
 * the label alone hands a screen-reader user strictly less than a sighted one
 * has at the exact moment of deciding.
 */
function optionName(option: QuestionOption): string {
  return option.description ? `${option.label}. ${option.description}` : option.label;
}

/**
 * A structured question from the agent, answered in place.
 *
 * Chrome collapses at one question. The single-question call is the common
 * case and must not pay for the multi-question one, so `n of m`, Back and Next
 * only exist when there is more than one question — otherwise the card is a
 * prompt and an Answer button.
 *
 * Everything the user picks is local state. A reshown panel rebuilds the live
 * set from `pendingQuestions` and the user re-picks: half an answer is not
 * worth persisting, and a restored half-answer would describe intent nobody
 * confirmed this launch. Submitting posts exactly one `question-answer`
 * carrying every question's values, because the host parks the request as a
 * unit and answers it as one.
 *
 * There is no deny variant. A question the user does not want to answer is a
 * turn they do not want to continue, so stopping the turn is the ordinary
 * interrupt — spelled the way the composer spells it, and gated, because it
 * costs the user everything the turn has done so far and there is no undo.
 */
export function QuestionCard({
  item, sessionId,
}: {
  item: QuestionItem;
  sessionId: SessionId;
}) {
  const { state, post } = useStore();
  const [step, setStep] = useState(0);
  // Indices, not labels: two options may legitimately carry the same label,
  // and a label-keyed selection makes them the same option — picking one
  // checks both, and the answer that goes out is whichever the map collapsed
  // to. The index is the only identity a provider-supplied list actually has.
  const [selections, setSelections] = useState<Record<string, number[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // The host drops a second answer for a request it has already settled, and
  // the patch that would settle this card has to round-trip. Without local
  // state the button stays live in the meantime and a double-click gets no
  // feedback — the same reasoning as PermissionCard's `answered`.
  const [submitted, setSubmitted] = useState(false);
  // Stopping the turn is the one irreversible thing this card can do, and it
  // used to be a ghost button labelled "Cancel" — a word a user reads as
  // "dismiss this card". One in-place confirm step, not a dialog: a 300px
  // column has no room for a portal, and the confirm state costs zero
  // vertical space until it is entered.
  const [confirmingStop, setConfirmingStop] = useState(false);

  const total = item.questions.length;
  // Clamped rather than trusted: `questions` is provider-supplied, so a
  // shorter list arriving under the same item id would index past the end and
  // an empty one would index nothing. `current` is only read below the empty
  // guard, so the clamp alone makes every access in range.
  const current = item.questions[Math.min(step, total - 1)];

  // Scoped to the session and the item: `aria-describedby`/`aria-labelledby`
  // resolve document-wide, and two panes can hold same-id items from
  // different sessions. Same rationale as Composer's `*ReasonId`.
  const base = `question-${sessionId}-${item.id}`;
  const promptId = `${base}-prompt`;
  const advanceReasonId = `${base}-advance-reason`;
  const stopReasonId = `${base}-stop-reason`;
  const secretReasonId = `${base}-secret-reason`;
  const staleReasonId = `${base}-stale-reason`;

  const valuesFor = (spec: QuestionSpec): string[] => {
    const chosen = (selections[spec.id] ?? [])
      .map((i) => spec.options?.[i]?.label)
      .filter((label): label is string => label !== undefined);
    const free = (other[spec.id] ?? '').trim();
    if (!free) { return chosen; }
    // A single-select question has exactly one answer. Concatenating the
    // picked option and the free text posted two, which is a shape the agent
    // never asked for — so the typed answer displaces the pick, matching what
    // a user who types after picking plainly means.
    return spec.multiSelect ? [...chosen, free] : [free];
  };

  if (item.state !== 'pending') {
    return (
      <TranscriptItemShell
        role="tool"
        label={`Question — ${SETTLED[item.state]}`}
        ts={item.ts}
      >
        <div className="space-y-1.5 text-xs">
          {/* Every question, not just the first: a three-question ask that
              records one answer is a record of something that never
              happened. */}
          {item.questions.map((spec) => {
            const given = item.answers?.[spec.id];
            return (
              <div key={spec.id}>
                <div className="wrap-break-word font-medium">{spec.header}</div>
                <div className="wrap-break-word text-muted-foreground">{spec.question}</div>
                {given && given.length > 0 ? (
                  <div className="wrap-break-word">{given.join(', ')}</div>
                ) : item.state === 'answered' ? (
                  // A secret answer is deliberately absent from the record,
                  // and saying so is the point: "asked, answered, not kept".
                  <div className="text-muted-foreground italic">Not recorded</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </TranscriptItemShell>
    );
  }

  // A question with nothing to ask is a provider bug, not a card: rendering
  // the chrome around no question would offer an Answer button with nothing
  // to answer. Errors are state, so it degrades to a line rather than
  // throwing out of the transcript.
  if (total === 0) {
    return (
      <TranscriptItemShell role="tool" label="Question" ts={item.ts}>
        <div className="text-xs text-muted-foreground">A question arrived with nothing to ask</div>
      </TranscriptItemShell>
    );
  }

  // A reloaded session is served with `pendingQuestions: []`, but a persisted
  // item can still carry `state: 'pending'` from a previous process.
  // Answering that one would silently no-op — `answerQuestion` early-returns
  // when the requestId is gone. Only offer live controls while the host is
  // still waiting on this request.
  const isLive = state.byId[sessionId]?.pendingQuestions
    .some((q) => q.requestId === item.requestId) ?? false;

  if (!isLive) {
    return (
      <TranscriptItemShell
        role="tool"
        label="Question — No longer awaiting an answer"
        ts={item.ts}
      >
        <div className="my-0 rounded border-2 border-dashed border-muted-foreground/40 p-2 text-xs">
          <div className="mb-2 space-y-1.5">
            {item.questions.map((spec) => (
              <div key={spec.id}>
                <div className="wrap-break-word font-medium text-muted-foreground">
                  {spec.header}
                </div>
                <div className="wrap-break-word text-muted-foreground">{spec.question}</div>
              </div>
            ))}
          </div>
          <Button size="sm" disabled aria-label="Answer" aria-describedby={staleReasonId}>
            Answer
          </Button>
          {/* The same disabled-with-a-reason contract Composer uses: real
              rendered text behind `aria-describedby`, never a `title` — a
              title on a disabled control reaches neither keyboard focus nor
              most screen readers. */}
          <span id={staleReasonId} className="sr-only">
            This question is no longer awaiting an answer.
          </span>
        </div>
      </TranscriptItemShell>
    );
  }

  const stepped = total > 1;
  const last = step >= total - 1;
  // Advancing on nothing would post an empty key and leave the agent with an
  // answer that says less than the question did. Stopping the turn is the way
  // out.
  const canAdvance = valuesFor(current).length > 0;

  const choose = (values: number[]) => {
    setSelections({ ...selections, [current.id]: values });
  };

  const toggle = (index: number) => {
    const chosen = selections[current.id] ?? [];
    if (!current.multiSelect) { choose([index]); return; }
    // Clicked order, not spec order: the list the agent receives should read
    // the way the user built it.
    choose(chosen.includes(index) ? chosen.filter((v) => v !== index) : [...chosen, index]);
  };

  const submit = () => {
    setSubmitted(true);
    const answers: QuestionAnswers = {};
    for (const spec of item.questions) {
      const values = valuesFor(spec);
      if (values.length > 0) { answers[spec.id] = values; }
    }
    post({ t: 'question-answer', id: sessionId, requestId: item.requestId, answers });
  };

  const picked = selections[current.id] ?? [];
  const freeText = current.allowOther || !current.options || current.options.length === 0;

  return (
    // The shell's uppercase micro-label and timestamp, like every other
    // transcript item — including this card's own settled variant, which had
    // them while the state that actually blocks the composer did not.
    <TranscriptItemShell role="question" label="Question" ts={item.ts}>
      {/* The `attention` tone the roster already owns for "the agent is
          blocked on you" (status-badge.tsx). Three signals have to survive:
          destructive red is a decision with consequences (permission), primary
          is an answer is required, a plain border is an optional offer
          (relocation) — which is exactly what this card wore before, so a
          frozen composer looked like an invitation. */}
      <div className="my-0 rounded border-2 border-primary/40 bg-primary/10 p-2 text-xs">
        {stepped && (
          // Mounted for the life of the card and only its text changes — the
          // same shape as StatusBadge's live region, and the reason it is not
          // conditionally rendered: a region created after the fact announces
          // nothing, and one torn down and rebuilt announces twice. Next used
          // to replace the whole card with focus parked on Next, so step 2
          // existed only visually.
          <span aria-live="polite" className="sr-only">
            {`Question ${step + 1} of ${total}: ${current.header}. ${current.question}`}
          </span>
        )}
        <div className="mb-1 flex items-baseline gap-2">
          <span className="min-w-0 wrap-break-word font-medium">{current.header}</span>
          {stepped && (
            // aria-hidden: the live region above already says "Question 2 of
            // 3", so an exposed counter is the same fact read twice.
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground" aria-hidden>
              {`${step + 1} of ${total}`}
            </span>
          )}
        </div>
        {/* The group's accessible name lives here: without it the question is
            an orphaned line and the control group announces as an unnamed set
            of radios. */}
        <div id={promptId} className="mb-2 wrap-break-word text-muted-foreground">
          {current.question}
        </div>

        {current.options && current.options.length > 0 && (
          current.multiSelect ? (
            // A checkbox set has no grouping element of its own, unlike
            // RadioGroup, so the group role is declared here.
            <div role="group" aria-labelledby={promptId} className="mb-2 grid gap-1.5">
              {current.options.map((opt, i) => (
                <OptionRow
                  // Positional: two options may share a label, and a
                  // label-keyed list reconciles them onto one row.
                  key={i}
                  option={opt}
                  onPick={() => toggle(i)}
                  control={
                    <Checkbox
                      className="mt-0.5"
                      aria-label={optionName(opt)}
                      checked={picked.includes(i)}
                      onCheckedChange={() => toggle(i)}
                    />
                  }
                />
              ))}
            </div>
          ) : (
            <RadioGroup
              className="mb-2 gap-1.5"
              aria-labelledby={promptId}
              value={picked[0] !== undefined ? String(picked[0]) : null}
              onValueChange={(value) => choose([Number(value)])}
            >
              {current.options.map((opt, i) => (
                <OptionRow
                  key={i}
                  option={opt}
                  onPick={() => toggle(i)}
                  control={
                    <RadioGroupItem
                      className="mt-0.5"
                      value={String(i)}
                      aria-label={optionName(opt)}
                    />
                  }
                />
              ))}
            </RadioGroup>
          )
        )}

        {freeText && (
          <>
            <Input
              className={cn('h-7 text-xs', current.secret ? 'mb-1' : 'mb-2')}
              // Specific, not generic: the masking is visible to a sighted
              // user and invisible to everyone else, so the name has to carry
              // it.
              aria-label={current.secret ? 'Your answer (hidden)' : 'Your answer'}
              aria-describedby={current.secret ? secretReasonId : undefined}
              type={current.secret ? 'password' : 'text'}
              value={other[current.id] ?? ''}
              placeholder={current.options?.length ? 'Something else…' : undefined}
              onChange={(e) => setOther({ ...other, [current.id]: e.target.value })}
            />
            {current.secret && (
              // Before the value is typed, not after it is sent. The settled
              // card's "Not recorded" is a receipt; the moment that needs the
              // reassurance is the moment the credential is on the clipboard.
              <div id={secretReasonId} className="mb-2 wrap-break-word text-muted-foreground">
                This answer is not written to the transcript.
              </div>
            )}
          </>
        )}

        {confirmingStop && (
          // Visible, not sr-only, and in flow above the control — the same
          // treatment Composer gives the reason its whole box is inert. The
          // consequence has to be legible to the person about to click, which
          // is precisely what an `aria-label` nobody can see was not.
          <p
            id={stopReasonId}
            className="mb-1.5 flex items-start gap-1.5 text-muted-foreground"
          >
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>Stopping ends this turn. The question goes unanswered and nothing is undone.</span>
          </p>
        )}
        {/* Stop first in DOM and tab order — it is the way out, the way Deny
            leads on a permission card. The step controls sit together on the
            trailing edge so Next stays in one place as the stepper advances
            and only its last stop changes its name. */}
        <div className="flex items-center gap-2">
          {confirmingStop ? (
            <Button
              variant="outline"
              size="sm"
              className="h-auto shrink-0 px-1 py-0 text-xs"
              // Leaving the control is an answer too: a user who clicks away
              // into the options has not asked to stop anything.
              onBlur={() => setConfirmingStop(false)}
              onClick={() => post({ t: 'interrupt', id: sessionId })}
              aria-label="Stop the turn"
              aria-describedby={stopReasonId}
            >
              Stop the turn?
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto shrink-0 px-1 py-0 text-xs"
              onClick={() => setConfirmingStop(true)}
              aria-label="Stop"
            >
              Stop
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {stepped && (
              <Button
                variant="outline"
                size="sm"
                disabled={step === 0}
                onClick={() => setStep(step - 1)}
                aria-label="Back"
              >
                Back
              </Button>
            )}
            {stepped && !last ? (
              <Button
                size="sm"
                disabled={!canAdvance}
                aria-describedby={canAdvance ? undefined : advanceReasonId}
                onClick={() => setStep(step + 1)}
                aria-label="Next"
              >
                Next
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canAdvance || submitted}
                aria-describedby={canAdvance ? undefined : advanceReasonId}
                onClick={submit}
                aria-label="Answer"
              >
                Answer
              </Button>
            )}
          </div>
          {!canAdvance && (
            // sr-only rather than visible, unlike the stop consequence above:
            // this one explains a control the user re-enables by doing the
            // one thing the card is already asking for, and the card has no
            // room for a standing sentence at 300px.
            <span id={advanceReasonId} className="sr-only">
              {freeText
                ? 'Choose an option or type an answer to continue.'
                : 'Choose an option to continue.'}
            </span>
          )}
        </div>
      </div>
    </TranscriptItemShell>
  );
}

/**
 * Label over description, never beside it: at 300px an inline pair wraps into
 * an unreadable ribbon. The text block repeats the control's action on click —
 * a redundant affordance over a control that is already keyboard-reachable and
 * carries its own expanded hit area, not a replacement for it.
 */
function OptionRow({
  option, control, onPick,
}: {
  option: QuestionOption;
  control: ReactNode;
  onPick: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      {control}
      <div className="min-w-0 flex-1">
        <div className="cursor-pointer" onClick={onPick}>
          <div className="wrap-break-word">{option.label}</div>
          {option.description && (
            <div className="wrap-break-word text-muted-foreground">{option.description}</div>
          )}
        </div>
        {option.preview && <OptionPreview label={option.label} preview={option.preview} />}
      </div>
    </div>
  );
}

/**
 * A preview is model-supplied arbitrary text, so it takes the same path as
 * assistant output — `Markdown`, which parses no raw HTML — rather than a new
 * sanitization story. Collapsed by default and mounted only once opened: an
 * option list whose previews were all expanded would bury the choice itself.
 *
 * `<details>`/`<summary>` is the disclosure exception `transcript-item.tsx`
 * already carries — semantics, not a control, with no vendored equivalent —
 * and `open` is driven from React state so the mount lands in the same update
 * as the click rather than a tick later on the browser's queued `toggle`.
 */
function OptionPreview({ label, preview }: { label: string; preview: string }) {
  const [open, setOpen] = useState(false);

  return (
    <details className="mt-1" open={open}>
      <summary
        className={cn('cursor-pointer text-muted-foreground', open && 'mb-1')}
        aria-label={open ? `Hide preview for ${label}` : `Show preview for ${label}`}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        Preview
      </summary>
      {open && (
        // Clamped and scrollable, matching the error item in
        // transcript-item.tsx: the content is model-supplied and a 400-line
        // preview would otherwise push the card — and the controls that
        // answer it — past the viewport with no boundary to scroll against.
        <div className="max-h-48 overflow-auto rounded border border-border p-1.5 wrap-break-word">
          <Markdown>{preview}</Markdown>
        </div>
      )}
    </details>
  );
}
