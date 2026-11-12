import {
  Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount,
} from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { PROVIDER_FILLS, PROVIDER_LOGOS } from './provider-logos';

export type MemberState = 'running' | 'blocked' | 'done' | 'failed';

export interface StackMember {
  providerId: string | undefined;
  name: string;
  state: MemberState;
}

const MAX_SHOWN = 3;

function Mark({ providerId }: { providerId: string | undefined }) {
  const base = providerId?.split(/[-:]/)[0];
  const key = providerId !== undefined && providerId in PROVIDER_LOGOS ? providerId : base;
  const d = key === undefined ? undefined : PROVIDER_LOGOS[key];
  if (!d || key === undefined) { return <span className="text-[0.6rem] leading-none font-medium uppercase">{providerId?.[0] ?? '?'}</span>; }
  return (
    <svg viewBox="0 0 24 24" fillRule={key === 'opencode' ? 'evenodd' : 'nonzero'} aria-hidden className="size-3.5 text-foreground">
      {key === 'codex' && (
        <defs>
          <linearGradient id="marcode-codex-gradient" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="3" y2="21">
            <stop stopColor="#B1A7FF" />
            <stop offset=".5" stopColor="#7A9DFF" />
            <stop offset="1" stopColor="#3941FF" />
          </linearGradient>
        </defs>
      )}
      <path d={d} fill={PROVIDER_FILLS[key] ?? 'currentColor'} />
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
