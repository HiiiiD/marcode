import { Composer } from "@/components/composer";
import type { PaneState } from "@/reducer";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import { summary } from "../fixtures/protocol";
import { posted, renderWithStore } from "./harness";

const pane = (over: Partial<PaneState["summary"]> = {}): PaneState => ({
  summary: summary("a", over), items: [], hasMore: false, pending: [], mcpServers: [],
  pendingQuestions: [], attachments: [],
});

const model = { id: "fake-small", displayName: "Fake Small" };

suite("Composer side chats", () => {
  test("/side posts start-side-chat with the question and sends nothing to the agent", async () => {
    renderWithStore(<Composer pane={pane()} model={model} models={[]} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;

    await userEvent.type(box, "/side why a clamp?{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "start-side-chat", id: "a", text: "why a clamp?" });
    assert.strictEqual(posted().some((m) => m.t === "send"), false);
    assert.strictEqual(box.value, "");
  });

  test("/btw is the same command", async () => {
    renderWithStore(<Composer pane={pane()} model={model} models={[]} />);

    await userEvent.type(screen.getByLabelText("Message"), "/btw why?{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "start-side-chat", id: "a", text: "why?" });
  });

  test("the bare command starts an empty side chat", async () => {
    renderWithStore(<Composer pane={pane()} model={model} models={[]} />);

    await userEvent.type(screen.getByLabelText("Message"), "/side{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "start-side-chat", id: "a" });
  });

  test("inside a side chat the request still goes to the host, which refuses it", async () => {
    renderWithStore(<Composer pane={pane({ kind: "side", parentId: "p" })} model={model} models={[]} />);

    await userEvent.type(screen.getByLabelText("Message"), "/side again{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "start-side-chat", id: "a", text: "again" });
  });

  test("a message that merely mentions /side is sent to the agent", async () => {
    renderWithStore(<Composer pane={pane()} model={model} models={[]} />);

    await userEvent.type(screen.getByLabelText("Message"), "use /side later{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "send", id: "a", text: "use /side later" });
  });
});
