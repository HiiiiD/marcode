interface SelectionRenderer {
  readonly hasSelection: boolean;
  getSelection(): { getSelectedText(): string } | null;
  copyToClipboardOSC52(text: string): boolean;
  clearSelection(): void;
}

/** Copies the drag selection, if any, and reports whether it consumed the key. */
export function copySelection(renderer: SelectionRenderer): boolean {
  if (!renderer.hasSelection) { return false; }
  const text = renderer.getSelection()?.getSelectedText() ?? '';
  if (text) { renderer.copyToClipboardOSC52(text); }
  renderer.clearSelection();
  return true;
}
