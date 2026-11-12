import { useNestedMessages } from './nested-messages-context';

export function NestedMessageList({ childId }: { childId: string | undefined }) {
  const messages = useNestedMessages(childId);
  if (messages.length === 0) { return null; }
  return (
    <ul aria-label="Messages from this worker" className="mb-1 flex flex-col gap-1 border-l border-border pl-2">
      {messages.map((m) => (
        <li key={m.id} className="max-h-32 overflow-auto text-xs wrap-break-word whitespace-pre-wrap text-muted-foreground">
          {m.text}
        </li>
      ))}
    </ul>
  );
}
