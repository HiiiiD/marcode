import type { ReactNode } from 'react';
// @ts-expect-error react-markdown ships ESM-only; tsc's per-file CJS/ESM
// interop check (tsconfig "module": "Node16") flags this as unimportable via
// require(), but esbuild bundles it directly and this is a type-check-only
// false positive.
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import { classifyHref } from './markdown-link';

/**
 * No plugins, and an explicit component map, because the webview's CSP is
 * `default-src 'none'`: an <img> or a stylesheet reference from agent output
 * would be blocked at load and show as a broken box, and it degrades to its
 * text. `react-markdown` does not parse raw HTML unless rehype-raw is added —
 * it is deliberately absent.
 *
 * A link is a button, never an <a>. An href in this webview is a navigation
 * nothing services — but the *destination* is one the host can reach, so the
 * click becomes a message instead: a URL to the OS browser, a path to an
 * editor pane. `markdown-link.ts` decides which, and anything neither (a bare
 * `#anchor`, a `javascript:` URL) stays plain text.
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
      // react-markdown's default transform blanks every href whose scheme is
      // not http(s)/mailto — which includes `e:\repo\a.ts`, since a Windows
      // drive letter parses as a one-letter scheme. Pass hrefs through and let
      // classifyHref, which knows the difference, decide.
      urlTransform={(url) => url}
      components={{
        img: ({ alt }) => <span className="text-muted-foreground">{alt ?? 'image'}</span>,
        a: ({ href, children: text }) => <MarkdownLink href={href}>{text}</MarkdownLink>,
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

function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const { post } = useStore();
  const link = classifyHref(href);
  if (link.kind === 'none') { return <>{children}</>; }

  const target = link.kind === 'external' ? link.url : link.path;
  return (
    <Button
      variant="link"
      onClick={() => post(
        link.kind === 'external'
          ? { t: 'open-external', url: link.url }
          : { t: 'reveal-file', path: link.path, startLine: link.startLine },
      )}
      title={target}
      // Overrides the size variant's box and the base variant's `inline-flex`
      // / `nowrap`, never its focus ring: this one sits mid-sentence in
      // wrapping prose, so it has to break like the words around it and
      // inherit their size.
      className="inline h-auto p-0 align-baseline text-[length:inherit] font-normal whitespace-normal underline"
    >
      {children}
    </Button>
  );
}
