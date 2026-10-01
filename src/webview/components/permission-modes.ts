import {
  FilePen, Hand, Map as MapIcon, ShieldBan, Sparkles, Zap, type LucideIcon,
} from "lucide-react";
import type { PermissionMode, PermissionModeInfo } from "../../protocol/messages";
import {
  MODES as SHARED_MODES,
  modeRowsForProvider as sharedRowsForProvider,
  modesFor as sharedModesFor,
  type ModeRow as SharedModeRow,
} from "../../shared/permission-modes";

const ICONS: Record<PermissionMode, LucideIcon> = {
  default: Hand,
  acceptEdits: FilePen,
  auto: Sparkles,
  plan: MapIcon,
  dontAsk: ShieldBan,
  bypass: Zap,
};

export type ModeRow = SharedModeRow & { icon: LucideIcon };

const withIcon = (row: SharedModeRow): ModeRow => ({ ...row, icon: ICONS[row.value] });

export const MODES: ModeRow[] = SHARED_MODES.map(withIcon);

export const MODE_OF = (mode: PermissionMode) => MODES.find((m) => m.value === mode) ?? MODES[0];

export const modesFor = (declared: PermissionModeInfo[] | undefined): ModeRow[] => sharedModesFor(declared).map(withIcon);

export const modeRowsForProvider = (
  providerId: string | undefined,
  declared: PermissionModeInfo[] | undefined,
): ModeRow[] => sharedRowsForProvider(providerId, declared).map(withIcon);
