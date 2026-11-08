import { Button } from '@/components/ui/button';
import type { ContextBreakdown } from '../../providers/types';
import { clampPercent } from '../../client-core/context-format';

function MemoryRow({ path, percent, source, onOpenFile }: {
  path: string; percent?: number; source?: 'reported' | 'discovered'; onOpenFile: (path: string) => void;
}) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = cut < 0 ? '' : path.slice(0, cut + 1);
  const base = path.slice(cut + 1);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <Button variant="link" size="xs"
        className="h-auto min-w-0 flex-1 shrink justify-start gap-0 px-0 pl-4 font-normal"
        title={path} onClick={() => onOpenFile(path)}>
        {dir && <span className="min-w-0 truncate text-muted-foreground [direction:rtl]"><bdi dir="ltr">{dir}</bdi></span>}
        <span className="shrink-0">{base}</span>
      </Button>
      {source === 'discovered' && <span className="shrink-0 text-muted-foreground">Discovered</span>}
      {percent !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">{clampPercent(percent) === 0 ? '<1%' : `${clampPercent(percent)}%`}</span>}
    </div>
  );
}

export function MemoryFiles({ breakdown, onOpenFile }: {
  breakdown: ContextBreakdown; onOpenFile: (path: string) => void;
}) {
  const discovered = breakdown.memoryFilesDiscovery === 'complete' || breakdown.memoryFiles.some((file) => file.source === 'discovered');
  return (
    <div className="min-w-0">
      {(breakdown.memoryFilesDiscovery || discovered) && <p className="py-1 text-muted-foreground">
        {breakdown.memoryFilesDiscovery === 'unavailable'
          ? 'Instruction-file discovery unavailable.'
          : 'Discovered from OpenCode’s configuration. Loading and per-file usage are not reported.'}
      </p>}
      {breakdown.memoryFiles.length === 0 && breakdown.memoryFilesDiscovery !== 'unavailable' &&
        <p className="py-0.5 pl-4 text-muted-foreground">{discovered ? 'No instruction files discovered.' : 'No memory files loaded'}</p>}
      {breakdown.memoryFiles.map((file) => /^https?:\/\//.test(file.path)
        ? <p key={file.path} className="truncate py-0.5 pl-4 text-muted-foreground" title={file.path}>{file.path}</p>
        : <MemoryRow key={file.path} {...file} onOpenFile={onOpenFile} />)}
    </div>
  );
}
