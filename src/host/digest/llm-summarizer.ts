import { randomUUID } from 'node:crypto';
import type { SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';
import type { AgentProvider, AgentRun, EffortLevel } from '../../providers/types';
import { buildSummaryPrompt, parseLlmDigest } from './llm-prompt';

export interface LlmSummarizerOptions {
  provider: AgentProvider;
  model: string;
  effort: EffortLevel;
  /** Deliberately not a session's cwd: a project directory would load its CLAUDE.md into every summary. */
  cwd: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export class LlmSummarizer {
  constructor(private readonly o: LlmSummarizerOptions) {}

  async summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> {
    const run = this.o.provider.start({
      cwd: this.o.cwd,
      model: this.o.model,
      effort: this.o.effort,
      permissionMode: 'default',
      sessionId: `digest-${randomUUID()}`,
      withoutSelfControl: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('summarizer timed out')), this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      });
      const reply = await Promise.race([this.collect(run, buildSummaryPrompt(items)), timeout]);
      return parseLlmDigest(reply, base);
    } finally {
      if (timer) { clearTimeout(timer); }
      await run.dispose().catch(() => undefined);
    }
  }

  private async collect(run: AgentRun, prompt: string): Promise<string> {
    let reply = '';
    run.send(prompt);
    for await (const event of run.events) {
      if (event.kind === 'text') {
        reply += event.delta;
      } else if (event.kind === 'permission') {
        run.respondToTool(event.id, { allow: false, reason: 'The summarizer may not use tools.' });
      } else if (event.kind === 'question') {
        throw new Error('summarizer asked a question');
      } else if (event.kind === 'turn-end') {
        if (event.reason === 'error') { throw new Error(event.error ?? 'summarizer run failed'); }
        return reply;
      }
    }
    throw new Error('summarizer run ended without a reply');
  }
}
