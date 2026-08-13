import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const RULE: Record<string, string> = {
  user: 'border-l-muted-foreground/40',
  assistant: 'border-l-primary/40',
  tool: 'border-l-border',
  permission: 'border-l-destructive',
  error: 'border-l-destructive',
};

/**
 * One gutter idiom for every role, so scanning a 300px column is a matter of
 * reading a left rule and a label rather than comparing a 1px border to a 2px
 * one. `ts` is on every transcript item and had no renderer at all before.
 */
export function TranscriptItemShell({
  role, label, ts, children,
}: {
  role: 'user' | 'assistant' | 'tool' | 'permission' | 'error';
  label: string;
  ts?: number;
  children: ReactNode;
}) {
  return (
    <div className={cn('my-0 border-l-2 pl-2', RULE[role])}>
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {ts !== undefined && (
          <span
            className="text-[0.65rem] text-muted-foreground"
            title={new Date(ts).toLocaleString()}
          >
            {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
