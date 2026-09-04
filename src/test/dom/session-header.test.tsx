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
    unavailable: [],
    usage: {},
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
    unavailable: [],
    usage: {},
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
    // The composer mounts a named live region of its own for attachment
    // errors, on the same pre-mounted-and-empty principle. This badge is the
    // unnamed one.
    const badgeOf = () => screen.getAllByRole("status")
      .find((el) => el.getAttribute("aria-label") === null);
    assert.strictEqual(badgeOf()?.textContent, "");

    sendFromHost({ t: "sessions-changed", sessions: [summary("a", { permissionMode: "bypass" })] });
    assert.strictEqual(badgeOf()?.textContent, "Bypassing permissions");
  });

  test("the header shows the folder the agent is working in", () => {
    renderApp();
    hydrate({ cwd: "/repos/mar-code" });

    screen.getByText("mar-code");
    assert.strictEqual(
      screen.getByText("mar-code").getAttribute("title"),
      "/repos/mar-code",
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
      catalog: [...catalog(), { id: "other", displayName: "Other", models: [], permissionModes: [] }],
      unavailable: [],
      usage: {},
    });

    screen.getByText("Fake");
  });

  test("the pane's own menu can archive the session, not just hide it", async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByLabelText("More pane actions for Session a"));
    // `findBy`, not `getBy`: Base UI portals its menu asynchronously — every
    // other menu suite here opens one the same way.
    await userEvent.click(await screen.findByText("Archive Session a"));

    assert.ok(posted().some((m) => m.t === "close-session" && m.id === "a"));
  });

  test("the name is plain text until the pencil is clicked", () => {
    renderApp();
    hydrate();

    assert.strictEqual(screen.queryByLabelText("Session name for Session a") === null, true);
    screen.getByTitle("Session a");
  });

  test("clicking the pencil, editing the name and pressing Enter posts rename-session", async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByLabelText("Rename Session a"));
    const input = screen.getByLabelText("Session name for Session a");
    await userEvent.clear(input);
    await userEvent.type(input, "renamed-a{Enter}");

    assert.ok(posted().some((m) => m.t === "rename-session" && m.id === "a" && m.name === "renamed-a"));
    // Back to plain text — Enter closes the editor, it doesn't just commit.
    assert.strictEqual(screen.queryByLabelText("Session name for Session a") === null, true);
  });

  test("pressing Escape in the header's name field reverts without posting", async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByLabelText("Rename Session a"));
    const input = screen.getByLabelText("Session name for Session a");
    await userEvent.clear(input);
    await userEvent.type(input, "abandoned{Escape}");

    assert.strictEqual(posted().some((m) => m.t === "rename-session"), false);
    assert.strictEqual(screen.queryByLabelText("Session name for Session a") === null, true);
    screen.getByTitle("Session a");
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
