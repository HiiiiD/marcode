export interface TeamMember { name: string; task: string }

interface PreambleInput {
  lead: string;
  self: TeamMember;
  siblings: TeamMember[];
  scope?: string;
  commit: boolean;
}

const COMMIT_RULES = [
  'Commit only files you edited yourself: `git add <your paths>`, then `git commit -m "..." -- <your paths>`.',
  'Never run `git add -A`, `git add .` or `git commit -a`.',
  'Never run `git stash`, `reset`, `clean`, `rebase`, a force-push, or `checkout`/`restore` on paths you do not own.',
  'Never `--amend` a commit you did not make.',
  'On `index.lock`, wait a few seconds and retry. Never delete the lock file.',
  'Do not push. Only the lead pushes.',
  'Follow the repository\'s commit conventions.',
];

export function buildWorkerPreamble(o: PreambleInput): string {
  const lines = [
    `You are a collaborator on a team led by session "${o.lead}". You share one working tree with the lead`
      + (o.siblings.length > 0 ? ' and your siblings:' : '.'),
    ...o.siblings.map((s) => `- ${s.name}: ${s.task}`),
    'Do not revert or overwrite changes you did not make.',
  ];
  if (o.scope) { lines.push(`Your scope: ${o.scope}. Do not edit outside it.`); }
  lines.push(
    ...(o.commit ? COMMIT_RULES : ['Do not commit. Leave your changes uncommitted for the lead to review.']),
    `When finished, call marcode__send_message to "${o.lead}" with a short result`
      + (o.commit ? ' and the hashes of the commits you made, or "no commits".' : '.'),
    '',
    `Your task: ${o.self.task}`,
  );
  return lines.join('\n');
}
