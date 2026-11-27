interface OwnedBy {
  owner?: { host: string; pid: number };
  remote?: { deviceName: string; gap?: true; newerFormat?: true };
}

export function ownerReason(summary: OwnedBy): string | undefined {
  const { remote } = summary;
  if (remote?.newerFormat) { return `A newer Marcode on ${remote.deviceName} wrote data this one can't read; update.`; }
  if (remote) { return `On ${remote.deviceName}. Read-only here.${remote.gap ? ' Part of this transcript did not arrive.' : ''}`; }
  return summary.owner ? `Running in ${summary.owner.host} (pid ${summary.owner.pid}). Read-only here.` : undefined;
}
