import type { QuestionAnswers, QuestionSpec } from '../providers/types';

/**
 * The answers safe to write to the transcript JSONL.
 *
 * A question may declare its answer secret. Transcripts are durable files
 * under `context.storageUri`, so persisting one verbatim turns the panel into
 * a plaintext credential store. The key is dropped entirely rather than
 * replaced with a placeholder: combined with `state: 'answered'` on the item,
 * a missing key for a `secret` question reads as "asked, answered,
 * deliberately not recorded", and there is no fake value to mistake for real.
 */
export function persistableAnswers(
  questions: QuestionSpec[],
  answers: QuestionAnswers,
): QuestionAnswers {
  const secrets = new Set(questions.filter((q) => q.secret).map((q) => q.id));
  if (secrets.size === 0) { return answers; }
  const out: QuestionAnswers = {};
  for (const [id, values] of Object.entries(answers)) {
    if (!secrets.has(id)) { out[id] = values; }
  }
  return out;
}
