import { ChildrenList } from "@/components/children-list";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { ChildRef, SessionSummary } from "../../protocol/messages";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { posted, renderWithStore, resetHost, sendFromHost } from "./harness";

const CHILDREN: ChildRef[] = [
  { id: "fork1", title: "Fork of plan", origin: "fork", hidden: false, status: "idle" },
  { id: "side1", title: "Side: why a clamp?", origin: "side", hidden: true, status: "running" },
  { id: "promo1", title: "Promoted idea", origin: "side", hidden: false, status: "idle" },
];

function hydrate(sessions: SessionSummary[]) {
  sendFromHost({
    t: "hydrate", sessions, layout: layoutOf(sessions.map((s) => s.id)),
    snapshots: sessions.map((s) => snapshot(s.id, s)), catalog: catalog(), unavailable: [], usage: {},
  });
}

function mount(sessions: SessionSummary[], sessionId: string) {
  const rendered = renderWithStore(<ChildrenList sessionId={sessionId} />);
  hydrate(sessions);
  return rendered;
}

suite("ChildrenList", () => {
  test("a session without branches renders nothing", () => {
    const { container } = mount([summary("main")], "main");

    assert.strictEqual(container.childElementCount, 0);
  });

  test("the branches are collapsed behind a count and list each kind with its badge", async () => {
    mount([summary("main", { children: CHILDREN })], "main");
    assert.strictEqual(screen.queryByText("Fork of plan"), null);

    await userEvent.click(screen.getByRole("button", { name: /3 forks and side chats/ }));

    assert.ok(screen.getByText("Fork of plan"));
    assert.ok(screen.getByText("Fork"));
    assert.ok(screen.getByText("Side chat"));
    assert.ok(screen.getByText("Promoted"));
  });

  test("clicking a branch focuses it, hidden side chats included", async () => {
    mount([summary("main", { children: CHILDREN })], "main");
    await userEvent.click(screen.getByRole("button", { name: /3 forks and side chats/ }));
    resetHost();

    await userEvent.click(screen.getByRole("button", { name: /Side: why a clamp\?/ }));

    assert.deepStrictEqual(posted(), [{ t: "focus-session", id: "side1" }]);
  });

  test("a branch links back to the session it came from", async () => {
    mount([summary("main", { title: "Main plan" }), summary("kid", { parentId: "main", origin: "fork" })], "kid");
    resetHost();

    await userEvent.click(screen.getByRole("button", { name: "Branched from Main plan" }));

    assert.deepStrictEqual(posted(), [{ t: "focus-session", id: "main" }]);
  });

  test("when the parent is gone the origin is plain text with nothing to click", () => {
    mount([summary("kid", { parentId: "gone", origin: "fork" })], "kid");

    assert.ok(screen.getByText("Branched from a deleted chat"));
    assert.strictEqual(screen.queryByRole("button", { name: /Branched from/ }), null);
  });
});
