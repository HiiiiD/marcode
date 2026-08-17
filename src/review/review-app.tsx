import { useEffect } from 'react';
import { useStore } from './store';

export function ReviewApp() {
  const { state, post } = useStore();

  // Ask once on mount: this surface is the only thing that wants the fleet
  // diff, so it is the only thing that asks for it.
  useEffect(() => { post({ t: 'request-fleet-diff' }); }, [post]);

  return (
    <section aria-label="Changes across every working tree" className="flex h-screen min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto text-xs">
        {state.fleetDiffReason !== undefined ? (
          <div className="space-y-1 px-2 py-2">
            <p className="font-medium">Could not read the changes</p>
            <p className="text-muted-foreground">{state.fleetDiffReason}</p>
          </div>
        ) : state.fleetDiff === undefined ? (
          // Inherited as-is from the sidebar surface, including its lack of an
          // upper bound: a four-second read reads the same as a forty-
          // millisecond one. Replacing it with something more appealing is
          // tracked in §6 of the followups doc, not done here.
          <p className="px-2 py-2 text-muted-foreground">Reading the working trees…</p>
        ) : (
          <p className="px-2 py-2 text-muted-foreground">Nothing to review</p>
        )}
      </div>
    </section>
  );
}
