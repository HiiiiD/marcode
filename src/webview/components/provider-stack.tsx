import {
  Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount,
} from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { PROVIDER_LOGOS } from './provider-logos';

export type MemberState = 'running' | 'blocked' | 'done' | 'failed';

export interface StackMember {
  providerId: string | undefined;
  name: string;
  state: MemberState;
}

const MAX_SHOWN = 3;

function Mark({ providerId }: { providerId: string | undefined }) {
  const d = providerId === undefined ? undefined : PROVIDER_LOGOS[providerId] ?? PROVIDER_LOGOS[providerId.split(/[-:]/)[0]];
  if (!d) { return <span className="text-[0.6rem] leading-none font-medium uppercase">{providerId?.[0] ?? '?'}</span>; }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden className="size-3.5 text-foreground">
      <path d={d} />
    </svg>
  );
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
