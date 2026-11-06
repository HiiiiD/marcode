/** A child's request id as the parent knows it; session ids contain no colon. */
export function mirrorId(childId: string, requestId: string): string {
  return `${childId}:${requestId}`;
}

export function parseMirrorId(id: string): { childId: string; requestId: string } | undefined {
  const at = id.indexOf(':');
  if (at <= 0) { return undefined; }
  return { childId: id.slice(0, at), requestId: id.slice(at + 1) };
}
