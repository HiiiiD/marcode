import { createContext, useContext, useRef } from 'react';

export const PromptArmContext = createContext(300);

/**
 * A prompt replaces the composer the moment a request arrives, so a key the user meant for the composer
 * (a word with a `y` in it, Enter to send) can land on it. Keys are ignored until the prompt for this
 * request has been on screen for the arm delay; the check runs at key time against a render-time stamp.
 */
export function usePromptArmed(requestId: string): () => boolean {
  const delay = useContext(PromptArmContext);
  const stamp = useRef<{ id: string; at: number } | null>(null);
  if (stamp.current?.id !== requestId) { stamp.current = { id: requestId, at: performance.now() }; }
  return () => stamp.current !== null && performance.now() - stamp.current.at >= delay;
}
