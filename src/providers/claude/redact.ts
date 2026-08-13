// Best-effort redaction for text that may end up either persisted to disk
// (AgentSession.appendItem -> a session's JSONL transcript file) or shown in
// the UI as a turn-end error string.
//
// Why this exists: the installed SDK's `ProcessTransport` accumulates a
// `stderrTail` from the spawned `claude` CLI process unconditionally — not
// gated on the `Options.stderr` callback we deliberately leave unset (see
// claude-provider.ts's header comment) — and appends `. stderr: <up to a 2KB
// tail>` to the `Error` it throws on a nonzero exit or a signal kill. That
// message flows straight through `errorMessage()` in claude-provider.ts into
// a `turn-end` event, then `AgentSession.fail()`, then a persisted transcript
// item. The SDK pre-redacts a fixed table of well-known token shapes
// (`Bearer`/`Basic` headers, `sk-ant-*`, `sk-*`, `AKIA*`, `gh[opusr]_*`,
// `xox[baprs]-*`, JWTs) before that tail is captured, but anything outside
// that table — a custom gateway key, a bare non-`sk-`-prefixed
// `ANTHROPIC_AUTH_TOKEN`, a password embedded in a URL — passes through
// verbatim. This module is a second, independent pass applied to every
// message before it becomes an `AgentEvent`: it drops the stderr tail
// entirely (the exit-code/signal portion of the SDK's message already states
// the failure without it) and, as defense in depth, blanks a conservative
// set of secret-shaped substrings that can appear outside a stderr tail too
// (e.g. inside a thrown network error's message).
const STDERR_TAIL = /\.\s*stderr:[\s\S]*$/i;

const SECRET_SHAPED: RegExp[] = [
  // Authorization-header-shaped tokens.
  /\b(Bearer|Basic)\s+\S+/gi,
  // JWT-shaped: three dot-separated base64url segments.
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // key=value / key: value pairs whose key name is secret-ish.
  /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd|authorization)\b\s*[:=]\s*\S+/gi,
  // Credentials embedded in a URL (scheme://user:password@host).
  /:\/\/[^\s/]+:[^\s/@]+@/g,
];

export function redactSecrets(message: string): string {
  let out = message.replace(STDERR_TAIL, '');
  for (const pattern of SECRET_SHAPED) {
    out = out.replace(pattern, '[redacted]');
  }
  return out.trim();
}
