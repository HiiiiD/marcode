import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store';
import type { EffortLevel } from '../../protocol/messages';

/**
 * `create-session` has carried `model` and `effort` since the protocol was
 * written, and SessionManager.create resolves them (falling back to
 * `models[0]` and the model's default effort). The UI simply never sent them,
 * so every session silently took the first model. `cwd` stays `''` on purpose:
 * MessageRouter reads that as "use the workspace root", which is what a
 * single-root workspace wants and what `+ New` should keep meaning.
 */
export function SessionCreateMenu() {
  const { state, post } = useStore();
  const provider = state.catalog[0];
  const [modelId, setModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel | null>(null);

  const model = provider?.models.find((m) => m.id === modelId) ?? provider?.models[0];
  const chosenEffort: EffortLevel | undefined = effort ?? model?.effort?.default;

  const create = () => {
    if (!provider || !model) { return; }
    post({
      t: 'create-session',
      providerId: provider.id,
      cwd: '',
      model: model.id,
      ...(model.effort ? { effort: chosenEffort } : {}),
    });
    setModelId(null);
    setEffort(null);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="sm" className="shrink-0" disabled={!provider} />}
        aria-label="New session"
      >
        <PlusIcon aria-hidden />
        New
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuRadioGroup value={model?.id} onValueChange={setModelId}>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          {provider?.models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              {m.displayName}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {model?.effort && (
          <DropdownMenuRadioGroup
            value={chosenEffort ?? undefined}
            onValueChange={setEffort}
          >
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            {model.effort.levels.map((level) => (
              <DropdownMenuRadioItem key={level} value={level}>
                {level}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={create}>Create session</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
