import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function TipButton({ tip, label, expanded, className, onClick, children }: {
  tip: string;
  className?: string;
  label: string;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button variant="ghost" size="icon-sm" className={className} aria-label={label} aria-expanded={expanded} onClick={onClick} />
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
