export type AttachDecision = 'attach' | 'replace' | 'refuse-newer';

export function decideAttach(daemonProtocol: number, myProtocol: number): AttachDecision {
  if (daemonProtocol === myProtocol) { return 'attach'; }
  return daemonProtocol < myProtocol ? 'replace' : 'refuse-newer';
}
