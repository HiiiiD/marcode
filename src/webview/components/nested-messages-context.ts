import { createContext, useContext } from 'react';
import type { TranscriptItem } from '../../protocol/messages';

export type NestedMessage = Extract<TranscriptItem, { role: 'user' }>;

/** Messages a still-nested worker sent to its parent, keyed by the worker's session id. */
export const NestedMessagesContext = createContext<ReadonlyMap<string, NestedMessage[]>>(new Map());

export function useNestedMessages(childId: string | undefined): NestedMessage[] {
  const all = useContext(NestedMessagesContext);
  return (childId !== undefined && all.get(childId)) || [];
}
