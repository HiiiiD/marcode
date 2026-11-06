/** A child's request id as the parent knows it; session ids contain no colon. */
export function mirrorId(childId: string, requestId: string): string {
  return `${childId}:${requestId}`;
}
