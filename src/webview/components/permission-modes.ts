import { FilePen, Hand, Map, ShieldBan, Zap, type LucideIcon } from "lucide-react";
import type { PermissionMode } from "../../protocol/messages";

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
    value: "plan",
    label: "Plan",
    description: "Read and propose. Nothing on disk is changed.",
    icon: Map,
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
