import type { QuestionAnswers, QuestionSpec } from '../types';

/**
 * `AskUserQuestion`'s input -> neutral specs, or undefined when the payload
 * is not the documented shape. The input is model-supplied, so "not the
 * documented shape" is a real case and the caller degrades rather than throws.
 *
 * Claude has no question id. The question text is the id, because that is
 * exactly what `AskUserQuestionOutput.answers` is keyed by.
 */
export function toQuestionSpecs(input: Record<string, unknown>): QuestionSpec[] | undefined {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) { return undefined; }
  const specs: QuestionSpec[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) { return undefined; }
    const q = entry as Record<string, unknown>;
    if (typeof q.question !== 'string' || typeof q.header !== 'string') { return undefined; }
    if (!Array.isArray(q.options) || q.options.length === 0) { return undefined; }
    const options = [];
    for (const o of q.options) {
      if (typeof o !== 'object' || o === null) { return undefined; }
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== 'string' || typeof opt.description !== 'string') { return undefined; }
      options.push({
        label: opt.label,
        description: opt.description,
        ...(typeof opt.preview === 'string' ? { preview: opt.preview } : {}),
      });
    }
    specs.push({
      id: q.question,
      header: q.header,
      question: q.question,
      options,
      multiSelect: q.multiSelect === true,
      // The tool's schema promises the model that an "Other" escape is
      // provided by the harness, so it is never per-question on this side.
      allowOther: true,
      // Claude has no secret questions. Codex does.
      secret: false,
    });
  }
  return specs;
}

/**
 * Neutral answers -> the string map `AskUserQuestionOutput.answers` documents:
 * question text to answer, multi-select comma-joined.
 */
export function toSdkAnswers(answers: QuestionAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, values] of Object.entries(answers)) { out[id] = values.join(', '); }
  return out;
}
