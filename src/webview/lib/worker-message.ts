export interface WorkerMessage {
  label: 'Reply' | 'Failed' | 'Message';
  body: string;
  preview: string;
}

// Matches the turn `SubagentService.start` sends the parent when a worker settles.
const SETTLED = /^Subagent "[^"\n]*" (finished|failed):\n/;

export function parseWorkerMessage(text: string): WorkerMessage {
  const m = SETTLED.exec(text);
  const body = (m ? text.slice(m[0].length) : text).trim();
  const label = !m ? 'Message' : m[1] === 'finished' ? 'Reply' : 'Failed';
  const preview = body.split('\n').find((line) => line.trim() !== '')?.replace(/^[#>*\-\s]+/, '').trim() ?? '';
  return { label, body, preview };
}
