export interface ReindexIo {
  status(): Promise<{ enabled: boolean; llm: boolean }>;
  /** Undefined when nothing needs a model call: the router already ran the free extractive pass. */
  estimate(): Promise<{ sessions: number; approxInputTokens: number } | undefined>;
  confirm(detail: string): Promise<boolean>;
  reindex(): Promise<void>;
  info(message: string): void;
}

const FINISHED = 'Marcode memory reindex finished.';

export async function runMemoryReindex(io: ReindexIo): Promise<void> {
  const status = await io.status();
  if (!status.enabled) {
    io.info('Marcode memory is off (marcode.memory.enabled).');
    return;
  }
  let detail = 'Rebuild the memory index for every session (no model used for this step).';
  if (status.llm) {
    const est = await io.estimate();
    if (!est) {
      io.info(FINISHED);
      return;
    }
    detail += ` Then summarize ${est.sessions} hidden sessions with the configured model `
      + `(about ${Math.round(est.approxInputTokens / 1000)}k input tokens). This costs model usage.`;
  } else {
    detail += ' No summarizer is configured, so no model calls will be made.';
  }
  if (!(await io.confirm(detail))) { return; }
  await io.reindex();
  io.info(FINISHED);
}
