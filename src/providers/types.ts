export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * 'default'     — prompt on anything that falls through to a prompt
 * 'acceptEdits' — auto-accept file edits, still prompt for everything else
 * 'plan'        — read-only planning
 * 'dontAsk'     — deny anything not already permitted
 * 'bypass'      — allow everything
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypass';

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Absent when the model has no effort control. */
  effort?: { levels: EffortLevel[]; default: EffortLevel };
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  /** Provider-opaque. Never parsed by callers. */
  resumeToken?: string;
}

export type ToolDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; reason?: string };

export type AgentEvent =
  | { kind: 'session'; resumeToken: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-end'; id: string; ok: boolean; output: unknown }
  | { kind: 'permission'; id: string; name: string; input: unknown }
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

export interface AgentRun {
  send(text: string): void;
  readonly events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): ModelInfo[];
  start(opts: StartOptions): AgentRun;
}
