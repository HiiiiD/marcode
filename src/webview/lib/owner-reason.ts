export function ownerReason(summary: { owner?: { host: string; pid: number } }): string | undefined {
  return summary.owner ? `Running in ${summary.owner.host} (pid ${summary.owner.pid}). Read-only here.` : undefined;
}
