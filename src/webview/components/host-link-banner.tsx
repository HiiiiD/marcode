import { useStore } from '../store';

const COPY = {
  reconnecting: 'Reconnecting to the background host…',
  lost: 'Lost the background host; reload the window',
} as const;

export function HostLinkBanner() {
  const { state } = useStore();
  if (state.hostLink === 'connected') { return null; }
  return (
    <div role="status" className="mx-2 mt-2 rounded border-2 border-border bg-muted/40 p-2 text-xs">
      {COPY[state.hostLink]}
    </div>
  );
}
