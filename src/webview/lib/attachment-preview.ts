import type { Attachment } from '../../protocol/messages';

/**
 * The webview URI an image attachment can be rendered from, or undefined when
 * there is nothing loadable.
 *
 * Composed from one host-minted base rather than a URI per attachment: only
 * the host can call `asWebviewUri`, and shipping a URI on every `Attachment`
 * would put a host-specific string on the wire and into the transcript, where
 * it would go stale the moment the webview reloaded with a fresh resource
 * origin.
 *
 * Answers undefined for anything the store did not write itself. An adopted
 * file lives wherever the user keeps it, which is outside
 * `localResourceRoots`, so a URI for it would render as a broken image — a
 * worse answer than the icon.
 */
export function previewUriOf(attachment: Attachment): string | undefined {
  if (attachment.kind !== 'image' || !attachment.storeRelative) { return undefined; }
  const base = attachmentBase();
  return base ? `${base}/${attachment.storeRelative}` : undefined;
}

/**
 * Read at call time, not at module load: the element carrying it is written
 * by the host into the page's own HTML, and a module-scope read would run
 * before the DOM exists under any test that mounts a component directly.
 */
function attachmentBase(): string {
  const root = document.getElementById('root');
  const base = root?.dataset.attachmentBase ?? '';
  return base.replace(/\/$/, '');
}
