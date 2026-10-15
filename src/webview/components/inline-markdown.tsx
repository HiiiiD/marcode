// @ts-expect-error react-markdown ships ESM-only; same tsc CJS/ESM interop
// false positive as in markdown.tsx — esbuild bundles it fine.
import ReactMarkdown from 'react-markdown';

const INLINE = ['p', 'strong', 'em', 'del', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/**
 * One line of markdown for places that truncate: only inline emphasis and
 * code survive. Every other element unwraps to its text, so a link or list
 * marker can never put an interactive or block element inside a toggle button.
 */
export function InlineMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      allowedElements={INLINE}
      unwrapDisallowed
      components={{
        p: ({ children: content }) => <span>{content}</span>,
        h1: ({ children: content }) => <span className="font-semibold">{content}</span>,
        h2: ({ children: content }) => <span className="font-semibold">{content}</span>,
        h3: ({ children: content }) => <span className="font-semibold">{content}</span>,
        h4: ({ children: content }) => <span className="font-semibold">{content}</span>,
        h5: ({ children: content }) => <span className="font-semibold">{content}</span>,
        h6: ({ children: content }) => <span className="font-semibold">{content}</span>,
        code: ({ children: content }) => (
          <code className="rounded bg-muted px-1 text-[0.9em] not-italic">{content}</code>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
