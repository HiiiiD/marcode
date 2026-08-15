import type {
  EffortLevel, PermissionMode, SessionId, SessionRef, WebviewToHost,
} from "../../protocol/messages";
import { findModel, resolveEffort } from "../../shared/model-catalog";
import type { ClientState } from "../reducer";

/** Everything a session is created with, beyond its cwd. */
export interface CreateSettings {
  providerId: string;
  model: string;
  effort?: EffortLevel;
  mode: PermissionMode;
}

/**
 * The settings of a specific session, resolved against the catalog as it
 * stands now.
 *
 * Split out of `inheritedSettings` because handoff copies the session the
 * user is handing off FROM, which is the pane they typed `@handoff` in — not
 * whichever session happens to be focused.
 */
export function settingsFor(
  state: ClientState, sessionId: SessionId | null | undefined,
): CreateSettings | undefined {
  const source = state.sessions.find((s) => s.id === sessionId);
  // A provider can leave the catalog (or never arrive, before the probe
  // lands) while a session created against it is still on screen — fall back
  // rather than offering to create against a provider the host cannot honor.
  const provider = state.catalog.find((p) => p.id === source?.providerId) ?? state.catalog[0];
  if (!provider) { return undefined; }

  const inherited = provider.id === source?.providerId
    ? findModel(provider.models, source.model)
    : undefined;
  const model = inherited ?? provider.models[0];
  if (!model) { return undefined; }

  return {
    providerId: provider.id,
    model: model.id,
    // Not the raw inherited level: effort belongs to the model, so a level
    // this model's scale does not name has to give way to its default.
    effort: resolveEffort(model, inherited ? source?.effort : undefined),
    mode: source?.permissionMode ?? "default",
  };
}

/**
 * What `+ New` should create right now: the settings of the session the user
 * is working in.
 *
 * Creating a session used to mean answering four questions in a menu, every
 * time, when the answer was almost always "the same as the one I am already
 * in" — so that is the default, and the dialog exists for the rest. The
 * source is the FOCUSED session rather than the newest or the most recently
 * updated: a background session finishing a turn would otherwise quietly
 * become what the next `+ New` copies.
 *
 * `undefined` when the catalog has no provider to create against, which is
 * what disables both create controls.
 */
export function inheritedSettings(state: ClientState): CreateSettings | undefined {
  return settingsFor(state, state.focusedSessionId);
}

/** The wire message for `settings`. `cwd: ''` means the workspace root. */
export function createMessage(
  settings: CreateSettings,
  seed?: { text: string; refs: SessionRef[] },
): WebviewToHost {
  return {
    t: "create-session",
    providerId: settings.providerId,
    cwd: "",
    model: settings.model,
    ...(settings.effort ? { effort: settings.effort } : {}),
    mode: settings.mode,
    ...(seed ? { seed } : {}),
  };
}
