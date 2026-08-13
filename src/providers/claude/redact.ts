// Best-effort redaction for text that may end up either persisted to disk
// (AgentSession.appendItem -> a session's JSONL transcript file) or shown in
// the UI as a turn-end error string. Applied in two places: claude-provider.ts's
// `errorMessage()` (thrown-`Error` text — process spawn/exit failures), and
// map-events.ts's `type === 'result'` branch (the SDK's own `errors: string[]`
// field on a failed result — see that file's header comment). Both paths can
// reach a persisted transcript item, so both must be redacted.
//
// Why this exists: the installed SDK's `ProcessTransport` accumulates a
// `stderrTail` from the spawned `claude` CLI process unconditionally — not
// gated on the `Options.stderr` callback we deliberately leave unset (see
// claude-provider.ts's header comment) — and appends `. stderr: <up to a 2KB
// tail>` to the `Error` it throws on a nonzero exit or a signal kill. That
// message flows straight through `errorMessage()` into a `turn-end` event,
// then `AgentSession.fail()`, then a persisted transcript item. The SDK
// pre-redacts a fixed table of well-known token shapes (`Bearer`/`Basic`
// headers, `sk-ant-*`, `sk-*`, `AKIA*`, `gh[opusr]_*`, `xox[baprs]-*`, JWTs)
// before that tail is captured, but anything outside that table — a custom
// gateway key, a bare non-`sk-`-prefixed `ANTHROPIC_AUTH_TOKEN`, a password
// embedded in a URL — passes through verbatim. This module is a second,
// independent pass applied to every message before it becomes an
// `AgentEvent`.
//
// CORRECTED from an earlier pass of this module: the first version deleted
// the entire stderr tail outright. That over-corrected — a startup failure
// (bad auth, an expired/logged-out session, a missing or incompatible CLI, a
// native-binary load error) reduces to the bare, undiagnosable
// `Claude Code process exited with code 1` with the actual cause gone, which
// directly works against being able to tell *why* Claude logged you out and
// log back in. The tail is now KEPT, bounded to a fixed character budget and
// run through the same secret-shaped-substring redaction as the rest of the
// message, rather than deleted wholesale.
const STDERR_MARKER = /\.\s*stderr:\s*/i;
const STDERR_TAIL_BUDGET = 200;

/**
 * Keeps everything up to and including a `. stderr:` marker verbatim, and
 * bounds what follows to `STDERR_TAIL_BUDGET` characters (with an ellipsis
 * when truncated) rather than discarding it. The bound exists because the
 * SDK's own tail can run up to 2KB — legible for a human, but more than a
 * transcript item or a turn-end string needs to prove a diagnosis.
 */
function boundStderrTail(message: string): string {
  const match = STDERR_MARKER.exec(message);
  if (!match) { return message; }
  const head = message.slice(0, match.index + match[0].length);
  const tail = message.slice(match.index + match[0].length);
  const bounded = tail.length > STDERR_TAIL_BUDGET
    ? `${tail.slice(0, STDERR_TAIL_BUDGET)}…`
    : tail;
  return `${head}${bounded}`;
}

const SECRET_SHAPED: readonly [pattern: RegExp, replacement: string][] = [
  // Authorization-header-shaped tokens (the value, not the scheme word).
  [/\b(Bearer|Basic)\s+\S+/gi, '[redacted]'],
  // JWT-shaped: three dot-separated base64url segments, the first of which
  // starts with `ey` — the base64url encoding of `{"`, which every real JWT
  // header begins with (`{"typ":"JWT",...}` or `{"alg":...}`). Requiring
  // that prefix (rather than "any three 10+ char dot-separated runs", which
  // the earlier pass used) avoids false-positiving on ordinary dotted
  // identifiers — e.g. `some-service.production-east.internal-host` no
  // longer matches, since none of its segments start with `ey`.
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]'],
  // key=value / key: value pairs whose key name is secret-ish. Deliberately
  // excludes `authorization` — CORRECTED from the earlier pass, which
  // matched `authorization: required` (a benign, common auth-failure
  // message with no secret value in it) and blanked it to `[redacted]`, one
  // of the two "eats benign diagnostics" cases flagged by review. A leaked
  // `Authorization` header value is still caught by the `Bearer`/`Basic`
  // pattern above, which is how such headers are actually formatted.
  [/\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*\S+/gi, '[redacted]'],
  // Credentials embedded in a URL (scheme://user:password@host). Keeps the
  // `://` and `@` delimiters via the capture group so the result still
  // reads as a URL — `https://[redacted]@example.com` — rather than the
  // earlier pass's `https[redacted]example.com`, which review flagged as
  // mangled/illegible (the `://` itself was consumed by the match, gluing
  // the scheme directly onto `[redacted]` with no separator).
  [/(:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@'],
];

export function redactSecrets(message: string): string {
  let out = boundStderrTail(message);
  for (const [pattern, replacement] of SECRET_SHAPED) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}
