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
 * turn they do not want to continue, so Cancel is the ordinary interrupt.
 */
export function QuestionCard({
  item, sessionId,
}: {
  item: QuestionItem;
  sessionId: SessionId;
}) {
  const { state, post } = useStore();
  const [step, setStep] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // The host drops a second answer for a request it has already settled, and
  // the patch that would settle this card has to round-trip. Without local
  // state the button stays live in the meantime and a double-click gets no
  // feedback — the same reasoning as PermissionCard's `answered`.
  const [submitted, setSubmitted] = useState(false);

  const total = item.questions.length;
  // Clamped rather than trusted: `questions` is provider-supplied, so a
  // shorter list arriving under the same item id would index past the end and
  // an empty one would index nothing. `current` is only read below the empty
  // guard, so the clamp alone makes every access in range.
  const current = item.questions[Math.min(step, total - 1)];

  const valuesFor = (spec: QuestionSpec): string[] => {
    const picked = selections[spec.id] ?? [];
    const free = (other[spec.id] ?? '').trim();
    return free ? [...picked, free] : picked;
  };

  if (item.state !== 'pending') {
    return (
      <TranscriptItemShell role="tool" label="Question" ts={item.ts}>
        <div className="space-y-1 text-xs">
          {item.questions.map((spec) => {
            const given = item.answers?.[spec.id];
            return (
              <div key={spec.id}>
                <div className="wrap-break-word text-muted-foreground">
                  {`${spec.header} — ${item.state}`}
                </div>
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
      <div className="my-0 rounded border-2 border-dashed border-muted-foreground/40 p-2 text-xs">
        <div className="mb-1 wrap-break-word font-medium text-muted-foreground">
          {`${current.header} — no longer awaiting an answer`}
        </div>
        <div className="mb-2 wrap-break-word text-muted-foreground">{current.question}</div>
        <Button size="sm" disabled aria-label="Answer">Answer</Button>
      </div>
    );
  }

  const stepped = total > 1;
  const last = step >= total - 1;
  // Advancing on nothing would post an empty key and leave the agent with an
  // answer that says less than the question did. Cancel is the way out.
  const canAdvance = valuesFor(current).length > 0;

  const choose = (values: string[]) => {
    setSelections({ ...selections, [current.id]: values });
  };

  const toggle = (label: string) => {
    const picked = selections[current.id] ?? [];
    if (!current.multiSelect) { choose([label]); return; }
    // Clicked order, not spec order: the list the agent receives should read
    // the way the user built it.
    choose(picked.includes(label) ? picked.filter((v) => v !== label) : [...picked, label]);
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

  return (
    // Full border, not the destructive rule a permission wears: the agent is
    // asking, not proposing something irreversible. The lifted surface is what
    // separates it from the transcript around it.
    <div className="my-0 rounded border-2 border-border bg-muted/40 p-2 text-xs">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="min-w-0 wrap-break-word font-medium">{current.header}</span>
        {stepped && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {`${step + 1} of ${total}`}
          </span>
        )}
      </div>
      <div className="mb-2 wrap-break-word text-muted-foreground">{current.question}</div>

      {current.options && current.options.length > 0 && (
        current.multiSelect ? (
          <div className="mb-2 grid gap-1.5">
            {current.options.map((opt) => (
              <OptionRow
                key={opt.label}
                option={opt}
                onPick={() => toggle(opt.label)}
                control={
                  <Checkbox
                    className="mt-0.5"
                    aria-label={opt.label}
                    checked={picked.includes(opt.label)}
                    onCheckedChange={() => toggle(opt.label)}
                  />
                }
              />
            ))}
          </div>
        ) : (
          <RadioGroup
            className="mb-2 gap-1.5"
            value={picked[0] ?? null}
            onValueChange={(value) => choose([String(value)])}
          >
            {current.options.map((opt) => (
              <OptionRow
                key={opt.label}
                option={opt}
                onPick={() => toggle(opt.label)}
                control={
                  <RadioGroupItem className="mt-0.5" value={opt.label} aria-label={opt.label} />
                }
              />
            ))}
          </RadioGroup>
        )
      )}

      {(current.allowOther || !current.options || current.options.length === 0) && (
        <Input
          className="mb-2 h-7 text-xs"
          aria-label="Your answer"
          type={current.secret ? 'password' : 'text'}
          value={other[current.id] ?? ''}
          placeholder={current.options?.length ? 'Something else…' : undefined}
          onChange={(e) => setOther({ ...other, [current.id]: e.target.value })}
        />
      )}

      {/* Cancel first in DOM and tab order — it is the reversible-feeling
          choice, the way Deny leads on a permission card. The step controls
          sit together on the trailing edge so Next stays in one place as the
          stepper advances and only its last stop changes its name. */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto shrink-0 px-1 py-0 text-xs"
          onClick={() => post({ t: 'interrupt', id: sessionId })}
          aria-label="Cancel this turn"
        >
          Cancel
        </Button>
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
              onClick={() => setStep(step + 1)}
              aria-label="Next"
            >
              Next
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!canAdvance || submitted}
              onClick={submit}
              aria-label="Answer"
            >
              Answer
            </Button>
          )}
        </div>
      </div>
    </div>
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
        <div className="rounded border border-border p-1.5 wrap-break-word">
          <Markdown>{preview}</Markdown>
        </div>
      )}
    </details>
  );
}
