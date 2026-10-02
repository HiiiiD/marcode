import type { BoxRenderable } from '@opentui/core';
import { useRef, useState } from 'react';
import type { TuiTokens } from '../tokens/derive-tokens';
import { useSyntaxStyle } from '../tokens/tokens-provider';
import { diffView } from './diff-view';

export function DiffBlock(props: { unified: string; filetype: string | undefined; tokens: TuiTokens }) {
  const { tokens: t } = props;
  const syntaxStyle = useSyntaxStyle();
  const box = useRef<BoxRenderable | null>(null);
  // Pane width, not terminal width: panes resize independently, and an equal value bails out of the re-render.
  const [width, setWidth] = useState(0);
  return (
    <box ref={box} width="100%" onSizeChange={() => { setWidth(box.current?.width ?? 0); }}>
      <diff
        diff={props.unified}
        view={diffView(width)}
        filetype={props.filetype}
        syntaxStyle={syntaxStyle}
        showLineNumbers
        width="100%"
        wrapMode="word"
        fg={t.text}
        addedBg={t.diff.addedBg}
        removedBg={t.diff.removedBg}
        contextBg={t.diff.contextBg}
        addedSignColor={t.diff.addedSign}
        removedSignColor={t.diff.removedSign}
        lineNumberFg={t.diff.lineNumber}
        lineNumberBg={t.diff.contextBg}
        addedLineNumberBg={t.diff.addedLineNumberBg}
        removedLineNumberBg={t.diff.removedLineNumberBg}
      />
    </box>
  );
}
