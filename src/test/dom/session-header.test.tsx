import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, sendFromHost } from "./harness";

export function hydrate(over = {}) {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("a", over)],
    layout: layoutOf("a"),
    snapshots: [snapshot("a", over)],
    catalog: catalog(),
  });
}

/** Two sessions in the roster, both open in their own pane. */
function hydrateTwoPanes() {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("a"), summary("b")],
    layout: layoutOf("a", "b"),
    snapshots: [snapshot("a"), snapshot("b")],
    catalog: catalog(),
  });
}

suite("SessionHeader status", () => {
  test("status is announced as text, not colour alone", () => {
    renderApp();
    hydrate();
    sendFromHost({ t: "session-status", id: "a", status: "awaiting-approval" });

    const live = screen.getByText("Needs you");
    assert.strictEqual(live.closest("[aria-live]")?.getAttribute("aria-live"), "polite");
  });

  test("awaiting-approval and error read differently", () => {
    renderApp();
    hydrate();
    sendFromHost({ t: "session-status", id: "a", status: "error" });
    screen.getByText("Failed");
    assert.strictEqual(screen.queryByText("Needs you"), null);
  });

  test("the roster trigger counts sessions that need the user", () => {
    renderApp();
    hydrate();
    sendFromHost({ t: "session-status", id: "a", status: "awaiting-approval" });

    screen.getByText(/1 needs you/i);
  });

  test("only the header badge is a live region, not the roster count", () => {
    renderApp();
    hydrate();
    sendFromHost({ t: "session-status", id: "a", status: "awaiting-approval" });

    const badge = screen.getByText("Needs you");
    assert.strictEqual(badge.closest("[aria-live]")?.getAttribute("aria-live"), "polite");

    const rosterCount = screen.getByText(/1 needs you/i);
    assert.strictEqual(rosterCount.closest("[aria-live]"), null);
  });

  test("the bypass badge is a live region mounted before it has anything to say", () => {
    renderApp();
    hydrate({ permissionMode: "default" });

    // Mounted with `role="status"` (implicit aria-live="polite") from the
    // very first render, empty, rather than only once bypass is chosen — a
    // live region created with its announcement text already inside it is
    // typically not announced by assistive tech.
    const badge = screen.getByRole("status");
    assert.strictEqual(badge.textContent, "");

    sendFromHost({ t: "sessions-changed", sessions: [summary("a", { permissionMode: "bypass" })] });
    assert.strictEqual(screen.getByRole("status").textContent, "Bypassing permissions");
  });

  test("the header shows the folder the agent is working in", () => {
    renderApp();
    hydrate({ cwd: "/repos/hiiiid-code" });

    screen.getByText("hiiiid-code");
    assert.strictEqual(
      screen.getByText("hiiiid-code").getAttribute("title"),
      "/repos/hiiiid-code",
      "the basename is what fits at 300px; the full path is the tooltip",
    );
  });

  test("the title wins the space contest, not the model label", () => {
    renderApp();
    hydrate();

    const title = screen.getByTitle("Session a");
    assert.ok(title.className.includes("truncate"));
    const model = screen.getByLabelText("Model");
    assert.ok(model.className.includes("truncate"), "the model control must be able to shrink too");
  });

  test("the provider is hidden when only one is configured", () => {
    renderApp();
    hydrate();

    assert.strictEqual(screen.queryByText("Fake"), null);
  });

  test("the provider is shown, appended to the metadata span, once more than one is configured", () => {
    renderApp();
    sendFromHost({
      t: "hydrate",
      sessions: [summary("a")],
      layout: layoutOf("a"),
      snapshots: [snapshot("a")],
      catalog: [...catalog(), { id: "other", displayName: "Other", models: [] }],
    });

    screen.getByText("Fake");
  });

  test("the pane X removes the pane without archiving the session", async () => {
    renderApp();
    hydrateTwoPanes();

    await userEvent.click(screen.getByLabelText("Hide Session a from the split"));

    const layouts = posted().filter((m) => m.t === "set-layout");
    assert.deepStrictEqual(
      layouts.at(-1)!.layout.panes.map((p) => p.sessionId),
      ["b"],
    );
    assert.ok(
      !posted().some((m) => m.t === "close-session"),
      "X means hide; archiving is a deliberate choice made from the roster",
    );
  });
});
