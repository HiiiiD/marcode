import { formatEditorContext } from './format-editor-context';
import { withMarcodeIntro } from './marcode-context';
import type { EditorContext, Invocable } from './types';

/** Names of the commands that only run when the message starts with `/name`. */
export function bareNamesOf(entries: readonly Invocable[]): Set<string> {
  return new Set(entries.filter((e) => e.bare).map((e) => e.name));
}

function leadingCommand(text: string): string | undefined {
  return /^\/(\S+)/.exec(text)?.[1];
}

/**
 * A backend's own commands are recognised only at the very start of the
 * message, so anything prepended (the editor context, the first-turn intro)
 * turns `/compact` into plain prose. Those messages go out verbatim and do not
 * use up the intro; everything else gets the usual framing.
 */
export function composePrompt(
  text: string,
  context: EditorContext | undefined,
  bare: ReadonlySet<string>,
  introduced: boolean,
  isResume: boolean,
): { body: string; introduced: boolean } {
  const command = leadingCommand(text);
  if (command !== undefined && bare.has(command)) { return { body: text, introduced }; }
  const withContext = context ? `${formatEditorContext(context)}\n\n${text}` : text;
  return { body: withMarcodeIntro(withContext, introduced, isResume), introduced: true };
}
