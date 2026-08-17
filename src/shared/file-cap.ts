// The default and hard-ceiling file caps for a `request-fleet-diff`.
//
// Both the host (`src/host/fleet-diff.ts`, which clamps a requested cap and
// answers with it) and the review webview (`src/review/use-fleet-diff-requests.ts`,
// which has to agree with the host about what "the default" and "the
// ceiling" mean in order to compute the next cap to ask for) need the same
// two numbers. `src/shared/` exists precisely so the two bundles can agree on
// a constant without either importing across the host/webview boundary —
// `src/shared/usage-windows.ts` and `src/shared/model-catalog.ts` are the
// same pattern for the same reason.
export const FILE_CAP = 500;
export const MAX_FILE_CAP = 2000;
