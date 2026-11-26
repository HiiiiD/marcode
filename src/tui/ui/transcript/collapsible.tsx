import type { ReactNode } from 'react';

const MAX_WIDTH = 100;
// A native diff needs room to go side by side; prose and command output stay at the readable measure.
const WIDE_MAX_WIDTH = 180;

// Flat like the webview's rows: no frame or fill; selection is the transcript's gutter bar.
export function Collapsible(props: { open: boolean; wide?: boolean; header: ReactNode; children?: ReactNode }) {
  return (
    <box flexDirection="column" maxWidth={props.wide ? WIDE_MAX_WIDTH : MAX_WIDTH}>
      <box flexDirection="row" gap={1}>{props.header}</box>
      {/* Indented past the glyph, so the body hangs under the label column. */}
      {props.open ? <box flexDirection="column" paddingLeft={2}>{props.children}</box> : null}
    </box>
  );
}
