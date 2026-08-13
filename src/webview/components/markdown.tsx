// @ts-expect-error react-markdown ships ESM-only; tsc's per-file CJS/ESM
// interop check (tsconfig "module": "Node16") flags this as unimportable via
// require(), but esbuild bundles it directly and this is a type-check-only
// false positive.
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

/**
 * No plugins, and an explicit component map, because the webview's CSP is
 * `default-src 'none'`: an <img> or a stylesheet reference from agent output
 * would be blocked at load and show as a broken box, and an <a> is a
 * navigation this panel has no way to service. Both degrade to their text.
 * `react-markdown` does not parse raw HTML unless rehype-raw is added — it
 * is deliberately absent.
 *
 * Headings render as emphasized paragraphs, not <h1>-<h6>, on purpose: real
 * headings from arbitrary agent output would inject a nonsense document
 * outline into a panel whose own heading structure is established
 * elsewhere — the panel now has its own `h2` per pane (session-header.tsx),
 * so there is a real outline to pollute. All six levels are mapped, not just
 * `h1`-`h3`: an unmapped `h4`-`h6` would fall through to react-markdown's
 * default and emit a real heading.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        img: ({ alt }) => <span className="text-muted-foreground">{alt ?? 'image'}</span>,
        a: ({ children: text }) => <>{text}</>,
        pre: ({ children: content }) => (
          <pre className="my-1 overflow-x-auto rounded bg-muted p-1.5 text-xs whitespace-pre-wrap wrap-break-word">
            {content}
          </pre>
        ),
        code: ({ className, children: content }) => (
          <code className={cn('rounded bg-muted px-1 py-0.5 text-xs', className)}>
            {content}
          </code>
        ),
        ul: ({ children: content }) => <ul className="my-1 list-disc pl-4">{content}</ul>,
        ol: ({ children: content }) => <ol className="my-1 list-decimal pl-4">{content}</ol>,
        h1: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h2: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h3: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h4: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h5: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        h6: ({ children: content }) => <p className="mt-2 font-semibold">{content}</p>,
        p: ({ children: content }) => <p className="my-1 wrap-break-word">{content}</p>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
