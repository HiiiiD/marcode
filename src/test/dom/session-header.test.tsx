import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import { catalog, layoutOf, snapshot, summary, type ToolItem } from "../fixtures/protocol";
import { posted, renderApp, sendFromHost } from "./harness";
import type { TranscriptItem } from "../../protocol/messages";

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

/** One pane, mid-turn, hydrated with a transcript the header has to read. */
function hydrateWithItems(items: TranscriptItem[]) {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("a", { status: "running" })],
    layout: layoutOf("a"),
    snapshots: [snapshot("a", { items, status: "running" })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

function task(
  id: string, agent: string | undefined, state: ToolItem["state"], ts: number,
): ToolItem {
  return {
    id, ts, role: "tool", toolId: `tool-${id}`,
    tool: { kind: "subagent", label: "Task", action: "spawn", agent },
    state,
  };
}

function runningTask(id: string, agent: string | undefined, ts = 1000): ToolItem {
  return task(id, agent, "running", ts);
}

function settledTask(id: string, agent: string | undefined, ts = 1000): ToolItem {
  return task(id, agent, "ok", ts);
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

  test("a session with nothing running shows no subagent badge", () => {
    renderApp();
    hydrate();

    // `=== null, true`, never the node-valued form: a failing assert inspects
    // the actual value, and a jsdom node walks the whole document graph.
    assert.strictEqual(
      screen.queryByRole("button", { name: /running subagent/i }) === null, true,
    );
  });

  test("a running subagent is named and timed in the header", () => {
    renderApp();
    hydrateWithItems([runningTask("t1", "Explore")]);

    // The card itself may be a screenful up; the header never scrolls away.
    const badge = screen.getByRole("button", { name: /running subagent Explore/i });
    assert.ok(badge.textContent?.includes("Explore"));

    // And the status live region is untouched — it must stay mounted across
    // this, or a status change stops being announced.
    screen.getByText("Working");
  });

  test("the badge names the agent type, not the SDK tool name", () => {
    renderApp();
    hydrateWithItems([runningTask("t1", undefined)]);

    // No `subagent_type` on the call, so the label is all there is.
    screen.getByRole("button", { name: /running subagent Task/i });
  });

  test("several at once are counted, and clicking cycles through them", async () => {
    renderApp();
    hydrateWithItems([
      runningTask("t1", "Explore", 1000),
      runningTask("t2", "Plan", 2000),
    ]);

    // Oldest first: the one that has been waiting longest is the one the user
    // is most likely looking for.
    const badge = () => screen.getByRole("button", { name: /running subagent/i });
    assert.ok(/Explore.*1\/2/s.test(badge().textContent!));

    await userEvent.click(badge());
    assert.ok(/Plan.*2\/2/s.test(badge().textContent!), "the next click goes to the other one");

    await userEvent.click(badge());
    assert.ok(/Explore.*1\/2/s.test(badge().textContent!), "and it wraps");
  });

  test("the badge goes away when the subagent finishes", () => {
    renderApp();
    hydrateWithItems([runningTask("t1", "Explore")]);
    screen.getByRole("button", { name: /running subagent/i });

    sendFromHost({
      t: "session-patch",
      id: "a",
      patch: { op: "replace", item: settledTask("t1", "Explore") },
    });

    // `=== null, true`, never the node-valued form: a failing assert inspects
    // the actual value, and a jsdom node walks the whole document graph.
    assert.strictEqual(
      screen.queryByRole("button", { name: /running subagent/i }) === null, true,
    );
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
