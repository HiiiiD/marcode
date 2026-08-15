import {
  FilePen, Hand, Map as MapIcon, ShieldBan, Sparkles, Zap, type LucideIcon,
} from "lucide-react";
import type { PermissionMode, PermissionModeInfo } from "../../protocol/messages";

/**
 * One row per mode: a short label the trigger can wear at 300px, and a
 * sentence that says what the agent will actually be allowed to do. The
 * label alone never carried that — "deny" and "bypass" are opposites and
 * read as near-synonyms of "ask" to anyone who has not learned the set.
 *
 * Shared by the composer's mode menu and the create dialog rather than
 * duplicated: the two are the only places a mode is ever chosen, and a mode
 * described differently in each would be a mode the user has to learn twice.
 */
export const MODES: {
  value: PermissionMode; label: string; description: string; icon: LucideIcon;
}[] = [
  {
    value: "default",
    label: "Ask",
    description: "Approve every tool call before it runs.",
    icon: Hand,
  },
  {
    value: "acceptEdits",
    label: "Auto-edit",
    description: "File edits apply on their own. Everything else still asks.",
    icon: FilePen,
  },
  {
    value: "auto",
    label: "Auto",
    description: "The agent judges each call and only asks about the risky ones.",
    icon: Sparkles,
  },
  {
    value: "plan",
    label: "Plan",
    description: "Read and propose. Nothing on disk is changed.",
    icon: MapIcon,
  },
  {
    value: "dontAsk",
    label: "Deny",
    description: "Refuse anything not already allowed, without prompting.",
    icon: ShieldBan,
  },
  {
    value: "bypass",
    label: "Bypass",
    description: "Run everything without asking. Chosen before the first message.",
    icon: Zap,
  },
];

export const MODE_OF = (mode: PermissionMode) => MODES.find((m) => m.value === mode) ?? MODES[0];

export type ModeRow = (typeof MODES)[number];

/**
 * The rows to offer for one provider, in the shared order.
 *
 * Order comes from `MODES`, not from the provider: the list reads as a
 * severity ramp from "ask about everything" to "ask about nothing", and a
 * provider returning its modes in some other order would scramble that for
 * its sessions only.
 *
 * An undefined or empty list means the catalog has not loaded yet — the same
 * "no opinion" case `resolvePermissionMode` handles — so every row is shown
 * rather than none. A picker that renders empty while a probe is in flight
 * looks broken in exactly the moment the user is trying to start work.
 */
export function modesFor(declared: PermissionModeInfo[] | undefined): ModeRow[] {
  if (!declared || declared.length === 0) { return MODES; }
  const byId = new Map(declared.map((d) => [d.id, d]));
  return MODES
    .filter((m) => byId.has(m.value))
    .map((m) => {
      const description = byId.get(m.value)?.description;
      return description ? { ...m, description } : m;
    });
}
