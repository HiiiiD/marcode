import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { SyncPanel } from "../../protocol/messages";
import { posted, renderApp, sendFromHost } from "./harness";
import { hydrate } from "./session-header.test";

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const NOW = Date.now();
const PAIRED: Extract<SyncPanel, { state: "paired" }> = {
  state: "paired", server: "https://sync.example.com", deviceName: "desk", connection: "connected",
  devices: [
    { deviceId: "d-desk", name: "desk", lastSeenAt: NOW, self: true, revoked: false },
    { deviceId: "d-laptop", name: "laptop", lastSeenAt: NOW - 2 * 3_600_000, self: false, revoked: false },
    { deviceId: "d-old", name: "old-tower", lastSeenAt: NOW - 90 * 86_400_000, self: false, revoked: true },
  ],
  projects: [
    { path: "/w/marcode", name: "marcode", projectId: "github.com/HiiiiD/marcode", choice: "shared" },
    { path: "/w/scratch", name: "scratch", choice: "none" },
  ],
};

async function open(panel: SyncPanel) {
  renderApp();
  hydrate();
  await userEvent.type(screen.getByLabelText("Message"), "/sync{Enter}");
  await settle();
  sendFromHost({ t: "sync-panel", panel });
  await settle();
  return within(screen.getByRole("dialog"));
}

const syncPosts = () => posted().filter((m) => m.t.startsWith("sync-"));

suite("Sync dialog", () => {
  test("/sync opens the dialog, asks the host for its state, and sends nothing to the agent", async () => {
    const dialog = await open({ state: "unpaired", defaultName: "desk" });
    assert.strictEqual(posted().some((m) => m.t === "send"), false);
    assert.strictEqual(posted().some((m) => m.t === "sync-open"), true);
    assert.strictEqual(dialog.getByRole("heading", { name: "Sync" }).textContent, "Sync");
  });

  test("the host's open-sync opens it too", async () => {
    renderApp();
    hydrate();
    sendFromHost({ t: "open-sync" });
    await settle();
    assert.strictEqual(screen.queryByRole("dialog") !== null, true);
    assert.strictEqual(posted().some((m) => m.t === "sync-open"), true);
  });

  test("unpaired: Join posts the fields; Set up switches forms", async () => {
    const dialog = await open({ state: "unpaired", defaultName: "desk" });
    assert.strictEqual((dialog.getByLabelText("Device name") as HTMLInputElement).value, "desk");
    await userEvent.type(dialog.getByLabelText("Server address"), "https://sync.example.com");
    await userEvent.type(dialog.getByLabelText("Pairing code"), "MRC-ABC");
    await userEvent.click(dialog.getByRole("button", { name: "Join" }));
    const join = syncPosts().find((m) => m.t === "sync-join");
    assert.deepStrictEqual(join, { t: "sync-join", server: "https://sync.example.com", code: "MRC-ABC", name: "desk" });
    await userEvent.click(dialog.getByRole("button", { name: "Set up a new server instead" }));
    assert.strictEqual(dialog.queryByLabelText("Setup code") !== null, true);
    assert.strictEqual(dialog.queryByLabelText("Pairing code") === null, true);
  });

  test("while busy the submit is disabled and a second click posts nothing", async () => {
    const dialog = await open({ state: "unpaired", defaultName: "desk", busy: true });
    const before = syncPosts().length;
    const join = dialog.getByRole("button", { name: "Join" }) as HTMLButtonElement;
    assert.strictEqual(join.disabled, true);
    await userEvent.click(join);
    assert.strictEqual(syncPosts().length, before);
  });

  test("a field error sits under its field and is announced with it", async () => {
    const dialog = await open({ state: "unpaired", defaultName: "desk", error: { field: "code", message: "That pairing code expired." } });
    const input = dialog.getByLabelText("Pairing code");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    assert.strictEqual(describedBy !== "", true);
    assert.strictEqual(document.getElementById(describedBy)?.textContent, "That pairing code expired.");
    assert.strictEqual(input.getAttribute("aria-invalid"), "true");
  });

  test("paired: status line, devices, and revoke with an inline confirm", async () => {
    const dialog = await open(PAIRED);
    assert.strictEqual(dialog.getByText(/sync\.example\.com · desk · Connected/).textContent?.includes("Connected"), true);
    assert.strictEqual(dialog.getByText("this device").textContent, "this device");
    assert.strictEqual(dialog.queryByText("old-tower") === null, true);
    await userEvent.click(dialog.getByRole("button", { name: "More actions for laptop" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    const confirm = dialog.getByText(/Revoke laptop\?/);
    assert.strictEqual(confirm.textContent, "Revoke laptop? It keeps what it already downloaded; anything synced from now on uses a key it never had.");
    await userEvent.click(dialog.getByRole("button", { name: "Revoke" }));
    assert.deepStrictEqual(syncPosts().find((m) => m.t === "sync-revoke"), { t: "sync-revoke", deviceId: "d-laptop" });
    await userEvent.click(dialog.getByRole("button", { name: "1 revoked" }));
    assert.strictEqual(dialog.getByText("old-tower").textContent, "old-tower");
  });

  test("an unfinished revoke offers to finish it", async () => {
    const dialog = await open({ ...PAIRED, devices: [PAIRED.devices[0], { ...PAIRED.devices[2], unfinishedRevoke: true }] });
    await userEvent.click(dialog.getByRole("button", { name: "Finish revoking" }));
    assert.deepStrictEqual(syncPosts().find((m) => m.t === "sync-revoke"), { t: "sync-revoke", deviceId: "d-old" });
  });

  test("a pairing code is shown with its join command, and expires into a new-code button", async () => {
    const pairing = { code: "MRC-ABCDEF-GHIJKL-MNOPQR", expiresAt: Date.now() + 1100, joinCommand: "marcode sync join https://sync.example.com MRC-ABCDEF-GHIJKL-MNOPQR" };
    const dialog = await open({ ...PAIRED, pairing });
    assert.strictEqual(dialog.getByText("GHIJKL").textContent, "GHIJKL");
    assert.strictEqual(dialog.getByText(pairing.joinCommand).textContent, pairing.joinCommand);
    assert.strictEqual(dialog.queryByRole("button", { name: "Copy code" }) !== null, true);
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
    assert.strictEqual(dialog.getByText("Expired").textContent, "Expired");
    assert.strictEqual(dialog.queryByRole("button", { name: "Copy code" }) === null, true);
    await userEvent.click(dialog.getByRole("button", { name: "Make a new code" }));
    assert.strictEqual(syncPosts().some((m) => m.t === "sync-pair"), true);
  });

  test("Add a device asks the host for a code", async () => {
    const dialog = await open(PAIRED);
    await userEvent.click(dialog.getByRole("button", { name: "Add a device" }));
    assert.strictEqual(syncPosts().some((m) => m.t === "sync-pair"), true);
  });

  test("project memory choices are posted", async () => {
    const dialog = await open(PAIRED);
    await userEvent.click(dialog.getByRole("combobox", { name: "Memory for marcode" }));
    await userEvent.click(await screen.findByRole("option", { name: "Keep separate" }));
    assert.deepStrictEqual(syncPosts().find((m) => m.t === "sync-project"), { t: "sync-project", path: "/w/marcode", choice: "own" });
    await userEvent.click(dialog.getByRole("combobox", { name: "Memory for marcode" }));
    await userEvent.click(await screen.findByRole("option", { name: "Link to project…" }));
    await userEvent.type(dialog.getByLabelText("Project to link marcode to"), "github.com/x/y");
    await userEvent.click(dialog.getByRole("button", { name: "Link" }));
    assert.deepStrictEqual(syncPosts().filter((m) => m.t === "sync-project").at(-1), { t: "sync-project", path: "/w/marcode", choice: { link: "github.com/x/y" } });
    assert.strictEqual(dialog.getByText("no remote · not shared").textContent, "no remote · not shared");
  });

  test("long names truncate with the full value kept for hover", async () => {
    const longName = "a-very-long-device-name-that-goes-on-and-on";
    const longId = "github.com/an-organisation-with-a-long-name/and-a-long-repository";
    const dialog = await open({
      ...PAIRED,
      devices: [{ ...PAIRED.devices[0], name: longName }],
      projects: [{ path: "/w/r", name: "r", projectId: longId, choice: "shared" }],
    });
    assert.strictEqual(dialog.getByText(longName).getAttribute("title"), longName);
    const id = dialog.getByTitle(longId);
    assert.strictEqual((id.textContent ?? "").length < longId.length, true);
  });

  test("a revoked device only offers cleanup", async () => {
    const dialog = await open({ ...PAIRED, connection: "revoked" });
    assert.strictEqual(dialog.getByText("This device was removed from sync on another device.").textContent !== "", true);
    assert.strictEqual(dialog.queryByRole("button", { name: "Add a device" }) === null, true);
    await userEvent.click(dialog.getByRole("button", { name: "Remove this device's sync data" }));
    assert.strictEqual(syncPosts().some((m) => m.t === "sync-forget"), true);
  });

  test("unreachable keeps the devices but says so and offers a retry", async () => {
    const dialog = await open({ ...PAIRED, connection: "unreachable" });
    assert.strictEqual(dialog.getByText("Can't reach sync.example.com").textContent, "Can't reach sync.example.com");
    assert.strictEqual(dialog.queryByText("laptop") !== null, true);
    await userEvent.click(dialog.getByRole("button", { name: "Retry" }));
    assert.strictEqual(syncPosts().some((m) => m.t === "sync-refresh"), true);
  });

  test("leave asks first", async () => {
    const dialog = await open(PAIRED);
    await userEvent.click(dialog.getByRole("button", { name: "Leave sync…" }));
    assert.strictEqual(dialog.getByText("Leave sync? This device stops syncing and forgets its keys.").textContent !== "", true);
    await userEvent.click(dialog.getByRole("button", { name: "Leave" }));
    assert.strictEqual(syncPosts().some((m) => m.t === "sync-leave"), true);
  });
});

suite("Sync status chip", () => {
  test("hidden while healthy or off; shown and clickable when broken", async () => {
    renderApp();
    hydrate();
    await settle();
    assert.strictEqual(screen.queryByRole("button", { name: /^Sync/ }) === null, true);
    sendFromHost({ t: "sync-status", status: "ok" });
    await settle();
    assert.strictEqual(screen.queryByRole("button", { name: /^Sync/ }) === null, true);
    sendFromHost({ t: "sync-status", status: "offline" });
    await settle();
    assert.strictEqual(screen.getByRole("button", { name: "Sync offline" }).textContent, "Sync offline");
    sendFromHost({ t: "sync-status", status: "revoked" });
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Sync: device removed" }));
    assert.strictEqual(screen.queryByRole("dialog") !== null, true);
  });
});
