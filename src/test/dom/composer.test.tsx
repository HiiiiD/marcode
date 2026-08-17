import { Composer } from "@/components/composer";
import type { PaneState } from "@/reducer";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { QuestionRequest, SessionStatus } from "../../protocol/messages";
import { catalog, layoutOf, permission, question, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, renderWithStore, sendFromHost } from "./harness";
import { hydrate } from "./session-header.test";

function pane(status: SessionStatus = 'idle'): PaneState {
  return {
    summary: summary('a', { status }), items: [], hasMore: false, pending: [], mcpServers: [],
    pendingQuestions: [],
  };
}

/** A pane whose first message has already been sent. */
function startedPane(id: string): PaneState {
  return {
    summary: summary(id),
    items: [{ id: `i-${id}`, ts: 1, role: "user", text: "go" }],
    hasMore: false,
    pending: [],
    mcpServers: [],
    pendingQuestions: [],
  };
}

const WITH_EFFORT = catalog()[0].models[0]; // fake-large, effort low/medium/high
const NO_EFFORT = catalog()[0].models[1]; // fake-small

/** One session in the roster, in its own pane, with the effort-capable model. */
function hydrateOne() {
  sendFromHost({
    t: "hydrate",
    sessions: [summary("a")],
    layout: layoutOf("a"),
    snapshots: [snapshot("a")],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

/**
 * Base UI's Dialog opens through transitions that resolve on timers outliving
 * `userEvent.type`'s own `act()` scope, so without this flush its state
 * updates land after the test body returns and React logs a "not wrapped in
 * act" warning even though the assertions that follow are correct. Same
 * treatment as the ContextRing suite.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

suite("Composer", () => {
  test("Enter posts send and clears the textarea", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;

    await userEvent.type(box, "hello{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "send", id: "a", text: "hello" });
    assert.strictEqual(box.value, "");
  });

  test("/context opens the context dialog instead of sending the command", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;

    await userEvent.type(box, "/context{Enter}");
    await settle();

    assert.strictEqual(
      posted().some((m) => m.t === "send"), false,
      "the agent must never receive a command the panel answers itself",
    );
    assert.deepStrictEqual(posted().at(-1), { t: "request-context", id: "a" });
    assert.ok(screen.getByText("Context"));
    assert.strictEqual(box.value, "");
  });

  test("a message that merely mentions /context is still sent", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message");

    await userEvent.type(box, "run /context for me{Enter}");

    assert.deepStrictEqual(
      posted().at(-1), { t: "send", id: "a", text: "run /context for me" },
    );
  });

  test("Shift+Enter inserts a newline and posts nothing", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;

    await userEvent.type(box, "one{Shift>}{Enter}{/Shift}two");

    assert.deepStrictEqual(posted().at(-1), { t: "ready" });
    assert.strictEqual(box.value, "one\ntwo");
  });

  test("whitespace-only input leaves Send disabled and posts nothing", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message");

    await userEvent.type(box, "   ");

    assert.strictEqual(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"), true);
    await userEvent.type(box, "{Enter}");
    assert.deepStrictEqual(posted().at(-1), { t: "ready" });
  });

  test("a running session shows Stop beside Send; Stop posts interrupt", async () => {
    renderWithStore(<Composer pane={pane("running")} model={NO_EFFORT} models={[]} />);

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    assert.deepStrictEqual(posted().at(-1), { t: "interrupt", id: "a" });
  });

  test("Enter during a run still posts send, for the host to park", async () => {
    renderWithStore(<Composer pane={pane("running")} model={NO_EFFORT} models={[]} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;

    await userEvent.type(box, "next thing{Enter}");

    assert.deepStrictEqual(posted().at(-1), { t: "send", id: "a", text: "next thing" });
    assert.strictEqual(box.value, "");
  });

  test("a queued message is shown and can be cancelled", async () => {
    const queued = {
      summary: summary("a", { status: "running", queued: { text: "next thing" } }),
      items: [], hasMore: false, pending: [], mcpServers: [],
      pendingQuestions: [],
    };
    renderWithStore(<Composer pane={queued} model={NO_EFFORT} models={[]} />);

    assert.ok(screen.getByText("next thing"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));

    assert.deepStrictEqual(posted().at(-1), { t: "cancel-queued", id: "a" });
  });

  test("an idle session shows no queued row", () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    assert.strictEqual(screen.queryByRole("button", { name: "Cancel queued message" }) === null, true);
  });

  test("awaiting-approval also shows Stop", () => {
    renderWithStore(<Composer pane={pane("awaiting-approval")} model={NO_EFFORT} models={[]} />);
    screen.getByRole("button", { name: "Stop" });
  });

  test("a model without effort offers no Effort row in the mode menu", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    await screen.findByRole("menuitemradio", { name: /Ask/ });
    assert.strictEqual(screen.queryByRole("menuitem", { name: /Effort/ }) === null, true);
  });

  test("the Effort row names the current level, in its text and its accessible name", async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    const row = await screen.findByRole("menuitem", { name: /Effort/ });
    assert.ok(
      /medium/.test(row.textContent ?? ""),
      `the row must name the level, got ${JSON.stringify(row.textContent)}`,
    );
    // The dots are aria-hidden, so the value has to reach assistive tech
    // through the name — an item announcing "Effort" alone leaves a screen-
    // reader user arrowing blind.
    assert.ok(/medium/.test(row.getAttribute("aria-label") ?? ""));
  });

  /**
   * The readout follows an `ml-auto` track, so a value that renders wider
   * than the last one pulls the dots leftward out from under the pointer
   * setting them — high → medium jumped for exactly that reason. The fix is
   * to reserve the widest name by rendering every level stacked in one grid
   * cell and hiding the inactive ones, which jsdom cannot measure but can
   * confirm the mechanism of. Asserting the width in `ch` was the earlier,
   * wrong shape: `ch` is the advance of "0", not of "medium".
   */
  test("the Effort readout reserves the widest level in the scale", async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    const row = await screen.findByRole("menuitem", { name: /Effort/ });

    for (const level of WITH_EFFORT.effort!.levels) {
      const rendered = [...row.querySelectorAll("span")].filter((s) => s.textContent === level);
      assert.ok(rendered.length > 0, `${level} must be rendered so the readout box can reserve its width`);
      assert.strictEqual(
        rendered.some((s) => s.className.includes("invisible")),
        level !== "medium",
        `only the active level is visible; ${level} is ${level === "medium" ? "active" : "reserved"}`,
      );
    }
  });

  test("an arrow key on the Effort row steps the level and posts set-effort", async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    const row = await screen.findByRole("menuitem", { name: /Effort/ });
    row.focus();
    await userEvent.keyboard("{ArrowRight}");

    assert.deepStrictEqual(posted().at(-1), { t: "set-effort", id: "a", effort: "high" });
  });

  test("the Effort row does not close the menu when it is used", async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    const row = await screen.findByRole("menuitem", { name: /Effort/ });
    await userEvent.click(row);

    assert.strictEqual(
      screen.queryByRole("menuitem", { name: /Effort/ }) !== null,
      true,
      "setting a level must leave the menu open so the change is visible",
    );
  });

  test("each mode carries a description, not just a label", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    const plan = await screen.findByRole("menuitemradio", { name: /Plan/ });
    assert.ok(
      /Nothing on disk is changed/.test(plan.textContent ?? ""),
      "a bare label leaves the five modes indistinguishable to anyone who has not learned the set",
    );
  });

  test("picking a mode posts set-permission-mode", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Permission mode"));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));

    assert.deepStrictEqual(posted().at(-1), { t: "set-permission-mode", id: "a", mode: "plan" });
  });

  /**
   * The bypass-disabled reason (`<p id="bypass-reason...">`) is rendered
   * once per pane's Composer. A fixed, unqualified id would collide across
   * panes — `getElementById`, which is what `aria-describedby` resolves
   * against, returns only the first match in the whole document, so the
   * second pane's disabled bypass option would describe itself using the
   * first pane's reason text. A single-Composer test can never catch that;
   * this renders two.
   */
  test("the bypass-disabled reason id does not collide across panes", async () => {
    renderWithStore(
      <>
        <Composer pane={startedPane("a")} model={WITH_EFFORT} models={[]} />
        <Composer pane={startedPane("b")} model={WITH_EFFORT} models={[]} />
      </>,
    );

    const triggers = screen.getAllByLabelText("Permission mode");
    assert.strictEqual(triggers.length, 2);

    // Read each id while its own menu is open: the popup is portaled and
    // unmounts on close, so the reason text only exists to resolve against
    // for as long as the option that points at it does.
    await userEvent.click(triggers[0]);
    const optionA = await screen.findByRole("menuitemradio", { name: /bypass/i });
    const describedByA = optionA.getAttribute("aria-describedby");
    assert.ok(describedByA);
    assert.ok(document.getElementById(describedByA)?.textContent?.includes("Bypass can only be chosen"));
    await userEvent.keyboard("{Escape}");

    await userEvent.click(triggers[1]);
    const optionB = await screen.findByRole("menuitemradio", { name: /bypass/i });
    const describedByB = optionB.getAttribute("aria-describedby");
    assert.ok(describedByB);
    assert.ok(document.getElementById(describedByB)?.textContent?.includes("Bypass can only be chosen"));

    assert.notStrictEqual(describedByA, describedByB, "each pane must own a distinct reason id");
  });

  test("the composer settings share one height, from their size variants", () => {
    renderApp();
    hydrateOne();

    // The mode menu is a Button, whose `sm` variant writes an unqualified
    // `h-7`. `cn` is twMerge, so a hand-written height would REPLACE that
    // token rather than sit beside it — asserting the variant's own class
    // survived is what catches an override.
    const mode = screen.getByLabelText("Permission mode");
    assert.ok(
      /(?:^|\s)h-7(?:\s|$)/.test(mode.className),
      'the mode trigger must keep Button size="sm"; a hand-written height replaces it under twMerge',
    );
  });

  test("Send sits inside the input group, after the settings", () => {
    renderApp();
    hydrateOne();

    const group = screen.getByLabelText("Message").closest('[data-slot="input-group"]');
    assert.ok(group, "the textarea must live inside an InputGroup");

    const send = screen.getByRole("button", { name: "Send" });
    assert.ok(group!.contains(send), "Send must live inside the group, not in a row below it");

    const mode = screen.getByLabelText("Permission mode");
    assert.ok(
      mode.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
      "settings come first, the action comes last",
    );
  });

  test("Send stays live while the agent runs and says the message will wait", async () => {
    renderApp();
    hydrateOne();
    sendFromHost({ t: "session-status", id: "a", status: "running" });
    await userEvent.type(screen.getByLabelText("Message"), "next thing");

    const send = screen.getByRole("button", { name: "Send" });
    assert.strictEqual(
      (send as HTMLButtonElement).disabled, false,
      "a message typed during a run can be committed; the host parks it",
    );
    const describedBy = send.getAttribute("aria-describedby");
    assert.ok(describedBy, "Send must say the message will not go out immediately");
    const reason = document.getElementById(describedBy!);
    assert.ok(reason, "the aria-describedby target must be real, rendered text");
    assert.strictEqual(
      reason!.textContent,
      "The agent is working. This message is sent when the turn ends, or as soon as you stop it.",
    );
    screen.getByRole("button", { name: "Stop" });
  });

  test("Send carries no misleading title when disabled by an empty box", () => {
    renderApp();
    hydrateOne();

    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    assert.ok(send.disabled, "Send starts disabled with nothing typed");
    assert.strictEqual(
      send.getAttribute("title"),
      null,
      '"Send message" on a disabled, empty composer is misleading since clicking does nothing',
    );
    assert.strictEqual(
      send.getAttribute("aria-describedby"),
      null,
      "an empty box needs no explanatory reason the way the running state does",
    );
  });

  test("Send carries its discoverability title once there is text and the agent is idle", async () => {
    renderApp();
    hydrateOne();

    await userEvent.type(screen.getByLabelText("Message"), "hello");
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    assert.strictEqual(send.disabled, false);
    assert.strictEqual(send.getAttribute("title"), "Send message");
  });

  test("Stop still posts interrupt", async () => {
    renderApp();
    hydrateOne();
    sendFromHost({ t: "session-status", id: "a", status: "running" });

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    assert.deepStrictEqual(posted().at(-1), { t: "interrupt", id: "a" });
  });

  const CTX = {
    path: "src/host/agent-session.ts",
    languageId: "typescript",
    selection: { ranges: [{ startLine: 60, endLine: 73, text: "x" }], truncated: false },
  };

  test("no editor context means no control at all", () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    assert.strictEqual(screen.queryByRole("button", { name: /editor context/i }) === null, true);
  });

  test("an editor context reveals the control, on and naming the file", () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({ t: "editor-context", ctx: CTX });

    const toggle = screen.getByRole("button", { name: /editor context/i });
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
    // The accessible name carries the file even when the container query has
    // collapsed the visible label to an icon.
    assert.ok(/agent-session\.ts/.test(toggle.getAttribute("aria-label") ?? ""));
  });

  test("clicking the control posts the opposite of the session flag", async () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({ t: "editor-context", ctx: CTX });

    await userEvent.click(screen.getByRole("button", { name: /editor context/i }));

    assert.deepStrictEqual(posted().at(-1), {
      t: "set-include-context",
      id: "a",
      on: false,
    });
  });

  test("a session with the flag off renders the control unpressed", () => {
    const off = {
      summary: summary("a", { includeEditorContext: false }),
      items: [],
      hasMore: false,
      pending: [],
      mcpServers: [],
      pendingQuestions: [],
    };
    renderWithStore(<Composer pane={off} model={NO_EFFORT} models={[]} />);
    sendFromHost({ t: "editor-context", ctx: CTX });

    const toggle = screen.getByRole("button", { name: /editor context/i });
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
  });

  test("a context with no selection names the file without a line span", () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    sendFromHost({
      t: "editor-context",
      ctx: { path: "src/a.ts", languageId: "typescript" },
    });

    const toggle = screen.getByRole("button", { name: /editor context/i });
    const label = toggle.getAttribute("aria-label") ?? "";
    assert.ok(label.includes("src/a.ts"));
    assert.ok(!label.includes(":"));
  });

  test("the model label is a control that posts set-model", async () => {
    renderWithStore(
      <Composer pane={pane()} model={NO_EFFORT} models={[{ displayName: "Fake Small", id: "fake-small" }]} />,
    );

    await userEvent.click(screen.getByLabelText("Model"));
    await userEvent.click(await screen.findByRole("option", { name: "Fake Small" }));

    assert.deepStrictEqual(posted().at(-1), { t: "set-model", id: "a", model: "fake-small" });
  });

  test("a session persisted on a wire id shows the alias row's label, not the raw id", () => {
    const alias = { id: "opus", displayName: "Opus (1M context)", resolvedModel: "claude-opus-5" };
    renderWithStore(
      <Composer
        pane={{ ...pane(), summary: summary("a", { model: "claude-opus-5" }) }}
        model={alias}
        models={[alias]}
      />,
    );

    const trigger = screen.getByLabelText("Model");
    assert.ok(
      /Opus \(1M context\)/.test(trigger.textContent ?? ""),
      `expected the row label, got ${JSON.stringify(trigger.textContent)}`,
    );
  });

  test("the model control stays enabled once the session has started", () => {
    // `Query.setModel` retargets the live run, so a mid-conversation switch is
    // real — the control has no reason to freeze after the first message, and
    // no disabled-reason text to carry.
    renderApp();
    hydrate({ items: [{ id: "u1", ts: 1, role: "user", text: "hi" }] });
    const model = screen.getByLabelText("Model") as HTMLButtonElement;
    assert.strictEqual(model.disabled, false);
    assert.strictEqual(model.getAttribute("aria-describedby"), null);
  });

  test("switching the model mid-conversation posts set-model", async () => {
    renderWithStore(
      <Composer
        pane={startedPane("a")}
        model={NO_EFFORT}
        models={[{ displayName: "Fake Small", id: "fake-small" }]}
      />,
    );

    await userEvent.click(screen.getByLabelText("Model"));
    await userEvent.click(await screen.findByRole("option", { name: "Fake Small" }));

    assert.deepStrictEqual(posted().at(-1), { t: "set-model", id: "a", model: "fake-small" });
  });

  suite("a session whose provider is unavailable", () => {
    /** The roster after the provider a session was created against went away. */
    function hydrateWithoutProvider() {
      sendFromHost({
        t: "hydrate",
        sessions: [summary("a")],
        layout: layoutOf("a"),
        snapshots: [snapshot("a")],
        catalog: [],
        unavailable: [{ id: "fake", displayName: "Fake", reason: "Fake CLI not found." }],
        usage: {},
      });
    }

    test("says why, in the pane, rather than waiting for a failed send", () => {
      renderApp();
      hydrateWithoutProvider();

      assert.ok(screen.getByText(/Fake CLI not found\./));
    });

    test("cannot be typed into or sent to", () => {
      renderApp();
      hydrateWithoutProvider();

      const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
      const send = screen.getByLabelText("Send") as HTMLButtonElement;
      assert.strictEqual(box.disabled, true);
      assert.strictEqual(send.disabled, true);
    });

    test("cannot have its model changed", () => {
      // Every model row belongs to a provider that cannot run it: the catalog
      // this session's provider had is exactly what left with it.
      renderApp();
      hydrateWithoutProvider();

      assert.strictEqual((screen.getByLabelText("Model") as HTMLButtonElement).disabled, true);
    });

    test("keeps its transcript readable", () => {
      // The whole point of read-only over hiding: the work is still worth
      // reading, and the session comes back the moment the provider does.
      renderApp();
      sendFromHost({
        t: "hydrate",
        sessions: [summary("a")],
        layout: layoutOf("a"),
        snapshots: [snapshot("a", {
          items: [{ id: "u1", ts: 1, role: "user", text: "refactor the parser" }],
        })],
        catalog: [],
        unavailable: [{ id: "fake", displayName: "Fake", reason: "Fake CLI not found." }],
        usage: {},
      });

      assert.ok(screen.getByText("refactor the parser"));
    });
  });

  suite("a pending question", () => {
    function hydrateWith(pendingQuestions: QuestionRequest[]) {
      sendFromHost({
        t: "hydrate",
        sessions: [summary("a")],
        layout: layoutOf("a"),
        snapshots: [snapshot("a", { pendingQuestions })],
        catalog: catalog(),
        unavailable: [],
        usage: {},
      });
    }

    function hydrateWithPermission(pending: ReturnType<typeof snapshot>["pending"]) {
      sendFromHost({
        t: "hydrate",
        sessions: [summary("a")],
        layout: layoutOf("a"),
        snapshots: [snapshot("a", { pending })],
        catalog: catalog(),
        unavailable: [],
        usage: {},
      });
    }

    test("a blocking question disables the composer with a visible reason", () => {
      renderApp();
      hydrateWith([{ requestId: "r1", blocking: true, questions: question().questions }]);

      const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
      assert.strictEqual(box.disabled, true);
      const describedBy = box.getAttribute("aria-describedby");
      assert.ok(describedBy, "the box must point at the reason it is disabled");
      const reason = document.getElementById(describedBy!);
      assert.strictEqual(reason !== null, true, "the aria-describedby target must be real, rendered text");
      assert.strictEqual(reason!.textContent, "Answer the question above to continue.");
      assert.strictEqual(box.getAttribute("title"), null, "the reason must never ride a title attribute");
    });

    test("a non-blocking question leaves the composer usable", () => {
      renderApp();
      hydrateWith([{ requestId: "r1", blocking: false, questions: question().questions }]);

      assert.strictEqual((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
    });

    test("a pending permission still leaves the composer usable", () => {
      renderApp();
      hydrateWithPermission([{ requestId: "r1", tool: permission().tool }]);

      assert.strictEqual((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
    });

    test("the composer re-enables once the blocking question leaves the pending slice", () => {
      renderApp();
      hydrateWith([{ requestId: "r1", blocking: true, questions: question().questions }]);
      assert.strictEqual((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, true);

      sendFromHost({
        t: "session-snapshot",
        session: snapshot("a", { pendingQuestions: [] }),
      });

      assert.strictEqual((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
    });
  });
});
