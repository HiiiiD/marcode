import { SyntaxStyle } from '@opentui/core';
import type { TuiTokens } from './derive-tokens';

export function buildSyntaxStyle(t: TuiTokens | undefined): SyntaxStyle {
  if (!t) { return SyntaxStyle.create(); }
  const { syntax: s, markdown: md } = t;
  return SyntaxStyle.fromStyles({
    default: { fg: t.text },
    comment: { fg: s.comment, italic: true },
    keyword: { fg: s.keyword },
    string: { fg: s.string },
    number: { fg: s.number },
    function: { fg: s.function },
    'function.method': { fg: s.function },
    type: { fg: s.type },
    operator: { fg: s.operator },
    variable: { fg: s.variable },
    punctuation: { fg: s.punctuation },
    'markup.heading': { fg: md.heading, bold: true },
    'markup.strong': { fg: md.strong, bold: true },
    'markup.italic': { fg: t.text, italic: true },
    'markup.raw': { fg: md.code },
    'markup.link': { fg: md.link },
    'markup.link.url': { fg: md.link, underline: true },
    'markup.quote': { fg: md.quote, italic: true },
  });
}
