import type { EffortLevel, ModelInfo, PermissionMode, PermissionModeInfo } from '../types';
import type {
  ApprovalsReviewer, AskForApproval, CodexModel, SandboxMode, SandboxPolicy,
} from './wire';

export interface CodexThreadSettings {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
}

/**
 * Codex has three independent axes where the panel has one.
 *
 * `approvalPolicy` decides *whether* an approval is raised. `sandbox` decides
 * what can be touched without one. `approvalsReviewer` decides *who answers*
 * — this is the knob Codex's own UI labels "Approve for me", and it is the
 * only difference between 'default' and 'auto'.
 */
const SETTINGS: Record<PermissionMode, CodexThreadSettings> = {
  default:     { approvalPolicy: 'on-request', sandbox: 'workspace-write',     approvalsReviewer: 'user' },
  auto:        { approvalPolicy: 'on-request', sandbox: 'workspace-write',     approvalsReviewer: 'auto_review' },
  plan:        { approvalPolicy: 'never',      sandbox: 'read-only',           approvalsReviewer: 'user' },
  dontAsk:     { approvalPolicy: 'never',      sandbox: 'workspace-write',     approvalsReviewer: 'user' },
  bypass:      { approvalPolicy: 'never',      sandbox: 'danger-full-access',  approvalsReviewer: 'user' },
  // Not offered — see CODEX_MODES. Mapped anyway so the function is total:
  // an unoffered mode arriving here is a bug elsewhere, and landing on
  // default's settings is the safe reading of it.
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write',     approvalsReviewer: 'user' },
};

export function codexSettings(mode: PermissionMode): CodexThreadSettings {
  return SETTINGS[mode];
}

/**
 * The five modes Codex can honor.
 *
 * `acceptEdits` is absent on purpose. Under `workspace-write` an in-workspace
 * edit raises no approval at all, so a Codex `acceptEdits` would be a second
 * name for `default`. An honest five beats six with one that quietly does
 * nothing.
 */
export const CODEX_MODES: PermissionModeInfo[] = [
  { id: 'default', description: 'Codex asks before anything leaves the workspace.' },
  { id: 'auto', description: 'Codex reviews each request itself and only asks about risky ones.' },
  { id: 'plan', description: 'Read and propose. Nothing on disk is changed.' },
  { id: 'dontAsk', description: 'Refuse anything not already allowed, without prompting.' },
  { id: 'bypass', description: 'No sandbox and no prompts. Chosen before the first message.' },
];

/**
 * The struct spelling of the same sandbox choice.
 *
 * `thread/start` takes the bare `SandboxMode` enum; `turn/start` — which is
 * how a mid-session mode change is applied — takes the `SandboxPolicy`
 * struct. Same decision, two shapes, so both live here rather than being
 * open-coded at each call site.
 *
 * `workspaceWrite` carries `networkAccess: true`. Filesystem confinement
 * (writableRoots) is the axis these modes actually gate on; blocking the
 * network too meant `npm install`/`git fetch`/`curl` failed under every
 * prompted mode (default, auto, dontAsk), leaving `bypass` — no sandbox,
 * no prompts at all — as the only way to do ordinary networked dev work.
 * `readOnly` (plan) keeps `networkAccess: false`: it never writes, so
 * there is nothing a network call could exfiltrate a change into.
 *
 * WINDOWS: even with the knobs above set as loosely as this function ever
 * sets them, `workspace-write`/`read-only` sandboxing on codex-cli
 * 0.153.4/win32 breaks any command that shells out through Cygwin/MSYS
 * (Git Bash) or WSL's `bash.exe` stub — this is codex-cli's own sandbox
 * enforcement, upstream of anything this file controls. Measured live:
 * `codex`'s spawned process prepends a `.sbx-denybin` shim dir to `PATH`
 * and strips `Git\usr\bin` from it entirely, so `bash` resolves to
 * `System32\bash.exe` (the WSL launcher) instead of Git Bash, and calling
 * it fails talking to the LxssManager COM service
 * (`Bash/Service/CreateInstance/E_ACCESSDENIED`). Invoking real Git Bash by
 * full path fails differently: `CreateFileMapping ... Win32 error 5`
 * (ACCESS_DENIED) — Cygwin/MSYS needs a named shared-memory mapping to
 * emulate fork(), and codex's restricted token can't create one. Deeper
 * still, `git`/`node child_process.spawn` calls made by an *already
 * running* command (e.g. a test suite shelling out to git) fail with
 * `spawn EPERM`, sandbox mode notwithstanding — seatbelt/landlock on
 * mac/linux still let a sandboxed process spawn children and gate their
 * syscalls; codex's Windows sandbox instead blocks further process
 * creation outright. None of `approvalPolicy`/`sandbox`/`approvalsReviewer`
 * changes this — `bypass` is the only mode that avoids it, because it is
 * the only one that skips codex's Windows sandboxing altogether.
 */
export function sandboxPolicyOf(mode: PermissionMode): SandboxPolicy {
  switch (codexSettings(mode).sandbox) {
    case 'danger-full-access': return { type: 'dangerFullAccess' };
    case 'read-only': return { type: 'readOnly', networkAccess: false };
    default: return {
      type: 'workspaceWrite', writableRoots: [], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
  }
}

const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const isLevel = (e: string): e is EffortLevel => (LEVELS as string[]).includes(e);

/**
 * The effort scale for one Codex model, in the order the model reports it.
 *
 * Measured against codex-cli 0.147.0: gpt-5.6-sol and -terra offer
 * low|medium|high|xhigh|max|ultra, -luna stops at max, and gpt-5.5 / 5.4 stop
 * at xhigh. Only 'ultra' fell outside `EffortLevel`, so the union gained it
 * rather than this function gaining a filter — silently dropping the top
 * level of the newest model is a worse outcome than one more union member
 * that other providers simply never declare.
 *
 * `ReasoningEffort` is nonetheless an open string, so an unrecognized level
 * is still skipped: the union is shared with every provider and the slider
 * renders from it. A model whose whole set is inexpressible gets no effort
 * control, which is what `ModelInfo.effort` being optional is for.
 */
export function effortLevelsOf(model: CodexModel): ModelInfo['effort'] {
  const levels = model.supportedReasoningEfforts
    .map((o) => o.reasoningEffort)
    .filter(isLevel);
  if (levels.length === 0) { return undefined; }
  const preferred = model.defaultReasoningEffort;
  return {
    levels,
    default: isLevel(preferred) && levels.includes(preferred) ? preferred : levels[0],
  };
}
