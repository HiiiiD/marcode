import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { ProviderInfo } from "../../protocol/messages";
import { layoutOf, snapshot, summary } from "../fixtures/protocol";
import { renderApp, sendFromHost } from "./harness";

/**
 * Boots the app with one session, on one pane, using a single provider whose
 * catalog row is exactly what the test hands in. The session's model is
 * always the provider's first — the tests below are about permission modes,
 * not about model selection.
 */
async function bootWithProvider(provider: Omit<ProviderInfo, "models"> & {
  models: ProviderInfo["models"];
}): Promise<void> {
  renderApp();
  sendFromHost({
    t: "hydrate",
    sessions: [summary("a", { providerId: provider.id, model: provider.models[0].id })],
    layout: layoutOf("a"),
    snapshots: [snapshot("a", { providerId: provider.id, model: provider.models[0].id })],
    catalog: [provider],
    unavailable: [],
    usage: {},
  });
}

/** Opens the composer's permission-mode menu for the sole pane on screen. */
async function openModeMenu(): Promise<void> {
  await userEvent.click(screen.getByLabelText("Permission mode"));
}

suite("ModeMenu declared modes", () => {
  test("a provider that omits acceptEdits does not offer it", async () => {
    await bootWithProvider({
      id: "codex", displayName: "Codex",
      models: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex" }],
      permissionModes: [
        { id: "default" }, { id: "auto" }, { id: "plan" },
        { id: "dontAsk" }, { id: "bypass" },
      ],
    });
    await openModeMenu();
    // Wait for the menu's async open before querying it — see session-picker
    // tests's note on `Menu.Positioner` committing its popup a tick late.
    await screen.findByRole("menuitemradio", { name: /Plan/ });

    // Booleans and strings only — never hand a node to assert.
    assert.strictEqual(screen.queryByRole("menuitemradio", { name: /Auto-edit/ }) === null, true);
  });

  test("a provider description overrides the shared one", async () => {
    await bootWithProvider({
      id: "codex", displayName: "Codex",
      models: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex" }],
      permissionModes: [
        { id: "default", description: "Codex asks before it leaves the workspace." },
      ],
    });
    await openModeMenu();
    await screen.findByRole("menuitemradio", { name: /Ask/ });

    assert.strictEqual(
      screen.getByText("Codex asks before it leaves the workspace.").textContent,
      "Codex asks before it leaves the workspace.",
    );
  });
});
