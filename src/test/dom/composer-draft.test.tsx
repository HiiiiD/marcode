import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { TranscriptItem } from "../../protocol/messages";
import { catalog, layoutOf, singlePaneLayout, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, resetHost, sendFromHost } from "./harness";

const said = (id: string, text: string): TranscriptItem =>
  ({ id, ts: 1, role: "user", text }) as TranscriptItem;

function hydrate(over: { draft?: string; items?: TranscriptItem[]; withB?: boolean } = {}) {
  const { draft, items = [] } = over;
  const s = summary("a", draft === undefined ? {} : { draft });
  sendFromHost({
    t: "hydrate",
    sessions: [s],
    layout: singlePaneLayout("a"),
    snapshots: [snapshot("a", { ...s, items })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

function addB() {
  sendFromHost(
    { t: "sessions-changed", sessions: [summary("a"), summary("b")] },
    { t: "layout-changed", layout: layoutOf(["a", "b"]) },
  );
}

const boxes = () => (screen.getAllByLabelText("Message") as HTMLTextAreaElement[]).map((b) => b.value);
const drafts = () => posted().filter((m) => m.t === "set-draft");
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

suite("Composer draft", () => {
  test("a draft the host carried is in the box after hydrate", () => {
    renderApp();
    hydrate({ draft: "half a thought" });
    assert.deepStrictEqual(boxes(), ["half a thought"]);
  });

  test("typing posts one debounced set-draft with the latest text", async () => {
    renderApp();
    hydrate();
    resetHost();
    await userEvent.type(screen.getByLabelText("Message"), "abc");
    assert.deepStrictEqual(drafts(), []);
    await wait(600);
    assert.deepStrictEqual(drafts(), [{ t: "set-draft", id: "a", text: "abc" }]);
  });

  test("a layout change that remounts the pane keeps what was typed", async () => {
    renderApp();
    hydrate();
    await userEvent.type(screen.getByLabelText("Message"), "still here");
    addB();
    assert.deepStrictEqual(boxes(), ["still here"]);
  });

  test("a remount flushes the pending draft to the host", async () => {
    renderApp();
    hydrate();
    resetHost();
    await userEvent.type(screen.getByLabelText("Message"), "quick");
    addB();
    assert.deepStrictEqual(drafts().at(-1), { t: "set-draft", id: "a", text: "quick" });
  });

  test("sending clears the draft on the host", async () => {
    renderApp();
    hydrate({ draft: "go" });
    resetHost();
    await userEvent.type(screen.getByLabelText("Message"), "{Enter}");
    await wait(600);
    assert.deepStrictEqual(drafts().at(-1), { t: "set-draft", id: "a", text: "" });
  });
});

suite("Composer prompt recall", () => {
  const items = [said("1", "first prompt"), said("2", "second prompt")];

  test("ArrowUp on an empty box walks back through sent prompts, ArrowDown restores", async () => {
    renderApp();
    hydrate({ items });
    const box = screen.getByLabelText("Message");
    await userEvent.click(box);
    await userEvent.keyboard("{ArrowUp}");
    assert.deepStrictEqual(boxes(), ["second prompt"]);
    await userEvent.keyboard("{ArrowUp}");
    assert.deepStrictEqual(boxes(), ["first prompt"]);
    await userEvent.keyboard("{ArrowDown}");
    assert.deepStrictEqual(boxes(), ["second prompt"]);
    await userEvent.keyboard("{ArrowDown}");
    assert.deepStrictEqual(boxes(), [""]);
  });

  test("the unsent text comes back after stepping past the newest prompt", async () => {
    renderApp();
    hydrate({ items, draft: "typing" });
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    box.focus();
    box.setSelectionRange(0, 0);
    await userEvent.keyboard("{ArrowUp}");
    assert.deepStrictEqual(boxes(), ["second prompt"]);
    await userEvent.keyboard("{ArrowDown}");
    assert.deepStrictEqual(boxes(), ["typing"]);
  });

  test("ArrowUp with the caret inside a multi-line draft moves the caret, not the text", async () => {
    renderApp();
    hydrate({ items });
    await userEvent.type(screen.getByLabelText("Message"), "one{Shift>}{Enter}{/Shift}two{ArrowUp}");
    assert.deepStrictEqual(boxes(), ["one\ntwo"]);
  });

  test("editing a recalled prompt ends the walk", async () => {
    renderApp();
    hydrate({ items });
    await userEvent.click(screen.getByLabelText("Message"));
    await userEvent.keyboard("{ArrowUp}!");
    assert.deepStrictEqual(boxes(), ["second prompt!"]);
    await userEvent.keyboard("{ArrowUp}");
    assert.deepStrictEqual(boxes(), ["second prompt!"]);
  });
});
