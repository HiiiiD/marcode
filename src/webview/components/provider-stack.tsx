import {
  Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount,
} from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export type MemberState = 'running' | 'blocked' | 'done' | 'failed';

export interface StackMember {
  providerId: string | undefined;
  name: string;
  state: MemberState;
}

const MAX_SHOWN = 3;

// Original glyphs, not vendor logos: the webview loads no remote resources
// and a one-colour mark has to read at 12px.
function Mark({ providerId }: { providerId: string | undefined }) {
  const common = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className: 'size-3' } as const;
  switch (providerId) {
    case 'claude':
      return <svg {...common}><path d="M8 2v12M2.8 5l10.4 6M13.2 5L2.8 11" /></svg>;
    case 'codex':
      return <svg {...common}><path d="M3.5 5.5 7 8l-3.5 2.5M8.5 11h4" /></svg>;
    case 'opencode':
      return <svg {...common}><path d="M5.5 3.5h-2v9h2M10.5 3.5h2v9h-2" /></svg>;
    default:
      return <span className="text-[0.6rem] leading-none font-medium uppercase">{providerId?.[0] ?? '?'}</span>;
  }
}

const BADGE: Partial<Record<MemberState, string>> = {
  running: 'bg-muted-foreground motion-safe:animate-pulse',
  blocked: 'bg-primary',
  failed: 'bg-destructive',
};

export function ProviderAvatar({ member }: { member: StackMember }) {
  const badge = BADGE[member.state];
  return (
    <Avatar size="sm" title={`${member.name} · ${member.state === 'blocked' ? 'needs you' : member.state}`}>
      <AvatarFallback><Mark providerId={member.providerId} /></AvatarFallback>
      {badge && <AvatarBadge className={cn(badge)} />}
    </Avatar>
  );
}

/** Overlapping provider marks, the first three then `+N`; one member is a stack of one. */
export function ProviderStack({ members, className }: { members: StackMember[]; className?: string }) {
  const shown = members.slice(0, MAX_SHOWN);
  const rest = members.length - shown.length;
  return (
    <AvatarGroup className={cn('shrink-0', className)}>
      {shown.map((m, i) => <ProviderAvatar key={`${m.name}-${i}`} member={m} />)}
      {rest > 0 && <AvatarGroupCount className="text-xs">+{rest}</AvatarGroupCount>}
    </AvatarGroup>
  );
}
