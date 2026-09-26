import { useEffect, useRef } from 'react';
import type { SessionId, WebviewToHost } from '../../protocol/messages';

const DEBOUNCE_MS = 400;

/**
 * Mirrors the composer text to the host so it survives a window reload. The
 * unmount flush is what covers a layout change: the pane remounts, the old
 * instance's pending timer is cancelled, and without it the host would keep
 * the text from before the last pause.
 */
export function useDraftSync(
  id: SessionId, text: string, post: (msg: WebviewToHost) => void,
): void {
  const sent = useRef(text);
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => {
    if (text === sent.current) { return; }
    const timer = setTimeout(() => {
      sent.current = text;
      post({ t: 'set-draft', id, text });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [id, text, post]);

  useEffect(() => () => {
    if (latest.current !== sent.current) {
      post({ t: 'set-draft', id, text: latest.current });
    }
  }, [id, post]);
}
