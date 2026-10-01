import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import { catalog, layoutOf, permission, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, sendFromHost } from "./harness";

function hydrateWith(owner?: { host: "vscode" | "tui"; pid: number }) {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("a", { owner })],
    layout: layoutOf(["a"]),
    snapshots: [snapshot("a", { owner })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite("a session owned by another host", () => {
  test("its composer is disabled and the owner is named", () => {
    renderApp();
    hydrateWith({ host: "vscode", pid: 1234 });
    screen.getByText(/Running in vscode \(pid 1234\)\. Read-only here\./);
    assert.strictEqual((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, true);
  });

  test("an owned session keeps an enabled composer", () => {
    renderApp();
    hydrateWith(undefined);
    assert.strictEqual((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
  });

  test("a pending permission card from the owner's transcript is inert here", async () => {
    renderApp();
    const owner = { host: "vscode" as const, pid: 1234 };
    // The dormant copy on this host never holds a live request, so its snapshot lists none.
    sendFromHost({
      t: "hydrate",
      sessions: [summary("a", { owner })],
      layout: layoutOf(["a"]),
      snapshots: [snapshot("a", { owner, items: [permission()], pending: [] })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });
    const allow = screen.getByLabelText("Allow Write (unavailable)") as HTMLButtonElement;
    const deny = screen.getByLabelText("Deny Write (unavailable)") as HTMLButtonElement;
    assert.deepStrictEqual([allow.disabled, deny.disabled], [true, true]);
    await userEvent.click(allow);
    assert.strictEqual(posted().some((m) => m.t === "permission-decision"), false);
  });
});
