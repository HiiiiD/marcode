import { screen } from "@testing-library/react";
import * as assert from "assert";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { renderApp, sendFromHost } from "./harness";

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
});
