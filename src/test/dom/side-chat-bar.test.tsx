import { SideChatBar } from "@/components/side-chat-bar";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { SessionSummary } from "../../protocol/messages";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, renderWithStore, resetHost, sendFromHost } from "./harness";

const sideSummary = (over: Partial<SessionSummary> = {}): SessionSummary =>
  summary("side", { kind: "side", parentId: "main", permissionMode: "plan", ...over });

function hydrate(parentStatus: SessionSummary["status"] = "idle") {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("main", { status: parentStatus })],
    layout: layoutOf(["main", "side"]),
    snapshots: [snapshot("main", { status: parentStatus }), snapshot("side", sideSummary())],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

/** The store must exist before the host's hydrate arrives, or the message has no listener. */
function mount(parentStatus: SessionSummary["status"] = "idle", sessionId = "side") {
  const rendered = renderWithStore(<SideChatBar sessionId={sessionId} />);
  hydrate(parentStatus);
  return rendered;
}

suite("SideChatBar", () => {
  test("names the pane and stays quiet while the side chat is read-only", () => {
    mount();

    assert.ok(screen.getByText("Side chat"));
    assert.strictEqual(screen.queryByText("Can edit files") === null, true);
  });

  test("warns once the side chat is in a mode that can edit", () => {
    mount();

    sendFromHost({ t: "side-summary", session: sideSummary({ permissionMode: "acceptEdits" }) });

    assert.ok(screen.getByRole("status"));
    assert.ok(screen.getByText("Can edit files"));
  });

  test("Bring back remains available while the main chat is working", async () => {
    mount("running");
    assert.strictEqual((screen.getByRole("button", { name: "Bring back" }) as HTMLButtonElement).disabled, false);
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));

    sendFromHost({ t: "session-status", id: "main", status: "awaiting-approval" });
    sendFromHost({ t: "session-status", id: "main", status: "running" });
    assert.strictEqual((screen.getByRole("button", { name: "Bring back" }) as HTMLButtonElement).disabled, false);
    sendFromHost({ t: "session-status", id: "main", status: "idle" });

    assert.strictEqual((screen.getByRole("button", { name: "Bring back" }) as HTMLButtonElement).disabled, false);
  });

  test("each action posts its message for the side chat", async () => {
    mount();
    resetHost();

    await userEvent.click(screen.getByRole("button", { name: "Promote" }));
    await userEvent.click(screen.getByRole("button", { name: "Close side chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));

    assert.deepStrictEqual(posted(), [
      { t: "promote-side-chat", id: "side" },
      { t: "close-side-chat", id: "side" },
      { t: "merge-side-chat", id: "side" },
    ]);
  });

  test("a refused bring back can be retried without a parent status change", async () => {
    mount();
    resetHost();

    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    sendFromHost({ t: "session-patch", id: "side", patch: { op: "append", item: {
      id: "error1", ts: 1, role: "error", message: "Nothing to bring back yet.",
    } } });
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));

    assert.deepStrictEqual(posted(), [
      { t: "merge-side-chat", id: "side" },
      { t: "merge-side-chat", id: "side" },
    ]);
    assert.strictEqual(screen.queryByRole("button", { name: "Queued for main chat" }) === null, true);
  });

  test("an ordinary session gets no bar", () => {
    const { container } = mount("idle", "main");

    assert.strictEqual(container.childElementCount, 0);
  });

  test("a side chat pane in the app shows the bar and a normal pane does not", () => {
    renderApp();
    hydrate();

    assert.strictEqual(screen.getAllByRole("group", { name: "Side chat" }).length, 1);
  });

  test("a side chat's items offer no fork until it is promoted", () => {
    renderApp();
    sendFromHost({
      t: "hydrate",
      sessions: [summary("main")],
      layout: layoutOf(["main", "side"]),
      snapshots: [
        snapshot("main"),
        snapshot("side", { ...sideSummary(), items: [{ id: "u1", ts: 1, role: "user", text: "why?" }] }),
      ],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    assert.strictEqual(screen.queryAllByRole("button", { name: "Fork from here" }).length, 0);
  });
});
