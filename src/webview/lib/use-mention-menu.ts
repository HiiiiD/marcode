import { useState, type KeyboardEvent } from 'react';
import { menuKeyAction, nextIndex } from './invocable-menu';

/**
 * The state machine behind an inline composer menu — the `/` invocables list
 * and the `@` mention list are the same interaction, and were the same code
 * written twice until the `@` copy quietly dropped the blur-close and started
 * claiming Enter over an empty list.
 *
 * The hook owns ONLY the machine: open/dismissed, the active index and its
 * clamp, which keys the menu claims, close-on-blur and close-after-pick. What
 * is in the list, and what picking a row does, stays with the caller — that is
 * the difference between the two menus, and the only one.
 */
export interface MentionMenu<Row> {
  /** True while the list should be rendered. */
  open: boolean;
  /** The rows to render — empty whenever the menu is closed. */
  rows: Row[];
  /** The highlighted row, already clamped against `rows`. */
  index: number;
  /**
   * The id of the highlighted row, for `aria-activedescendant` — undefined
   * when there is no addressable row, since an empty list's placeholder is
   * deliberately not one.
   */
  activeOptionId: string | undefined;
  /**
   * Handles a keydown, returning whether the menu claimed it. A claimed key
   * has already had its default prevented; an unclaimed one must fall through
   * to the composer untouched.
   */
  handleKeyDown: (e: KeyboardEvent) => boolean;
  /** Picks a row — for the mouse path, which does not go through keydown. */
  pick: (row: Row) => void;
  /** A fresh keystroke, or the control: undismiss and start at the top. */
  reset: () => void;
  /** Escape, or focus leaving the box. */
  dismiss: () => void;
}

export function useMentionMenu<Row>({
  triggered,
  rows,
  enabled = true,
  listId,
  onPick,
  claimsWhenEmpty = false,
}: {
  /** Whether the trigger text currently matches — the query, in other words. */
  triggered: boolean;
  /** The rows the trigger would show. Consulted only while open. */
  rows: Row[];
  /** A further gate: `false` keeps the menu shut whatever the trigger says. */
  enabled?: boolean;
  /** Prefix for row ids, so `aria-activedescendant` resolves per pane. */
  listId: string;
  onPick: (row: Row) => void;
  /**
   * Keep claiming keys with no rows to insert.
   *
   * The default — and the rule this hook exists to hold — is that a menu with
   * zero rows claims nothing, because a claimed Enter with nothing to insert
   * silently kills sending. The `/` menu opts in to preserve behaviour it has
   * shipped with: its trigger discipline (`/` at position 0, closed at the
   * first space) means an unmatched query is a lone `/word`, never the tail of
   * a real message.
   */
  claimsWhenEmpty?: boolean;
}): MentionMenu<Row> {
  /**
   * Escape, or focus leaving the box, closed the menu. Only a fresh keystroke
   * or the control reopens it — otherwise a user who dismissed the list would
   * have it spring back on the next render.
   */
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const open = enabled && triggered && !dismissed;
  const visible = open ? rows : [];
  const index = Math.min(activeIndex, Math.max(0, visible.length - 1));
  const activeOptionId = visible.length > 0 ? `${listId}-${index}` : undefined;
  const claims = open && (visible.length > 0 || claimsWhenEmpty);

  const pick = (row: Row) => {
    // Closing is the point: after a pick the caret sits at the end of whatever
    // was inserted, so the trigger usually still matches and the menu would
    // re-render over the row just taken — with the next Enter picking it a
    // second time instead of sending.
    setDismissed(true);
    setActiveIndex(0);
    onPick(row);
  };

  return {
    open,
    rows: visible,
    index,
    activeOptionId,
    pick,
    reset: () => { setDismissed(false); setActiveIndex(0); },
    dismiss: () => setDismissed(true),
    handleKeyDown: (e) => {
      if (!claims) { return false; }
      const action = menuKeyAction(e.key);
      if (action === 'pass') { return false; }
      e.preventDefault();
      if (action === 'move-down') { setActiveIndex(nextIndex(index, 1, visible.length)); }
      if (action === 'move-up') { setActiveIndex(nextIndex(index, -1, visible.length)); }
      if (action === 'close') { setDismissed(true); }
      if (action === 'select' && visible[index]) { pick(visible[index]); }
      return true;
    },
  };
}
