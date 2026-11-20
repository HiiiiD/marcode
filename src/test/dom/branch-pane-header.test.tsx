import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { SessionSummary } from "../../protocol/messages";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, resetHost, sendFromHost } from "./harness";

const sideSummary = (over: Partial<SessionSummary> = {}): SessionSummary =>
  summary("side", { kind: "side", parentId: "main", permissionMode: "plan", ...over });

function hydrate(side: SessionSummary = sideSummary()) {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("main", { name: "Main work" })],
    layout: layoutOf(["main", "side"]),
    snapshots: [snapshot("main"), snapshot("side", side)],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite("Branch pane header", () => {
  test("a side chat says what it is and whose it is, and is not dressed as a session", () => {
    renderApp();
    hydrate();

    const bar = screen.getByRole("group", { name: "Side chat" });
    assert.strictEqual(bar.textContent?.includes("Side chat"), true);
    assert.strictEqual(bar.textContent?.includes("of Main work"), true);
    assert.strictEqual(within(bar).queryByRole("button", { name: /^(Replace|Drag) / }) === null, true);
  });

  test("the origin is a link that focuses the parent", async () => {
    renderApp();
    hydrate();
    resetHost();

    await userEvent.click(screen.getByRole("button", { name: "of Main work" }));

    assert.deepStrictEqual(posted(), [{ t: "focus-session", id: "main" }]);
  });

  test("Bring back is in view, Promote and Close are one step away", async () => {
    renderApp();
    hydrate();
    resetHost();

    screen.getByRole("button", { name: "Side chat actions" }).focus();
    // Opened from the keyboard: a pointer click on a pane's menu button is swallowed by the pane's own focus handling under jsdom.
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("menuitem", { name: /Promote/ }));
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    await userEvent.click(screen.getByRole("button", { name: "Close side chat" }));

    assert.deepStrictEqual(posted().filter((m) => m.t !== "focus-pane"), [
      { t: "promote-side-chat", id: "side" },
      { t: "merge-side-chat", id: "side" },
      { t: "close-side-chat", id: "side" },
    ]);
  });

  test("the side chat's composer prompts for a side question", () => {
    renderApp();
    hydrate();

    assert.strictEqual(screen.getAllByPlaceholderText(/Side question/).length, 1);
  });
});
