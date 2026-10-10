export type AttachDecision = 'attach' | 'replace' | 'refuse-newer';

export function decideAttach(daemonProtocol: number, myProtocol: number): AttachDecision {
  if (daemonProtocol === myProtocol) { return 'attach'; }
  return daemonProtocol < myProtocol ? 'replace' : 'refuse-newer';
}

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;

/** Only plain `x.y.z` on both sides counts; a dev or prerelease build never triggers a replacement. */
export function isOlderBuild(daemon: string, mine: string): boolean {
  const a = PLAIN.exec(daemon);
  const b = PLAIN.exec(mine);
  if (!a || !b) { return false; }
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) { return d < 0; }
  }
  return false;
}
