import { Composer } from "@/components/composer";
import type { PaneState } from "@/reducer";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { SessionStatus } from "../../protocol/messages";
import { catalog, layoutOf, snapshot, summary } from "../fixtures/protocol";
import { posted, renderApp, renderWithStore, sendFromHost } from "./harness";
import { hydrate } from "./session-header.test";

function pane(status: SessionStatus = "idle"): PaneState {
  return { summary: summary("a", { status }), items: [], hasMore: false, pending: [] };
}

/** A pane whose first message has already been sent — hasStarted === true. */
function startedPane(id: string): PaneState {
  return {
    summary: summary(id),
    items: [{ id: `i-${id}`, ts: 1, role: "user", text: "go" }],
    hasMore: false,
    pending: [],
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

  test("a running session shows Send disabled and Stop beside it; Stop posts interrupt", async () => {
    renderWithStore(<Composer pane={pane("running")} model={NO_EFFORT} models={[]} />);

    assert.strictEqual(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"), true);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    assert.deepStrictEqual(posted().at(-1), { t: "interrupt", id: "a" });
  });

  test("awaiting-approval also shows Stop", () => {
    renderWithStore(<Composer pane={pane("awaiting-approval")} model={NO_EFFORT} models={[]} />);
    screen.getByRole("button", { name: "Stop" });
  });

  test("a model without effort renders no Effort control", () => {
    renderWithStore(<Composer pane={pane()} model={NO_EFFORT} models={[]} />);
    assert.strictEqual(screen.queryByLabelText("Effort"), null);
  });

  test("choosing an effort level posts set-effort", async () => {
    renderWithStore(<Composer pane={pane()} model={WITH_EFFORT} models={[]} />);

    await userEvent.click(screen.getByLabelText("Effort"));
    await userEvent.click(await screen.findByRole("option", { name: "high" }));

    assert.deepStrictEqual(posted().at(-1), { t: "set-effort", id: "a", effort: "high" });
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

    await userEvent.click(triggers[0]);
    const optionA = await screen.findByRole("option", { name: /bypass/i });
    const describedByA = optionA.getAttribute("aria-describedby");
    await userEvent.keyboard("{Escape}");

    await userEvent.click(triggers[1]);
    const optionB = await screen.findByRole("option", { name: /bypass/i });
    const describedByB = optionB.getAttribute("aria-describedby");

    assert.ok(describedByA);
    assert.ok(describedByB);
    assert.notStrictEqual(describedByA, describedByB, "each pane must own a distinct reason id");
    assert.ok(document.getElementById(describedByA!)?.textContent?.includes("Bypass can only be chosen"));
    assert.ok(document.getElementById(describedByB!)?.textContent?.includes("Bypass can only be chosen"));
  });

  test("the effort and mode selects use the sm size variant, not a hand-written height", () => {
    renderApp();
    hydrateOne();

    for (const label of ["Effort", "Permission mode"]) {
      const trigger = screen.getByLabelText(label);
      assert.strictEqual(
        trigger.getAttribute("data-size"),
        "sm",
        `${label} must set size="sm"; a hand-written h-7 loses to data-[size=default]:h-8`,
      );
      // Not \bh-\d: SelectTrigger's own base classes always carry both
      // `data-[size=default]:h-8` and `data-[size=sm]:h-7` as compound,
      // variant-qualified tokens (CSS picks the active one via the
      // data-size attribute) — a bare \b boundary matches "h-8"/"h-7"
      // inside those regardless of what we authored. A hand-written height
      // is always a space-separated, unqualified token instead. Also covers
      // `h-auto`, not just `h-<digit>` — the same hand-written-over-a-size-
      // variant defect tool-card.tsx and transcript.tsx once had.
      assert.ok(
        !/(?:^|\s)h-(?:\d|auto)/.test(trigger.className),
        `${label} must not hand-write a height over the size variant`,
      );
    }
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

  test("Send stays visible but disabled while the agent runs, with Stop beside it", () => {
    renderApp();
    hydrateOne();
    sendFromHost({ t: "session-status", id: "a", status: "running" });

    const send = screen.getByRole("button", { name: "Send" });
    assert.ok((send as HTMLButtonElement).disabled, "Send is disabled, not removed, during a run");
    assert.strictEqual(
      send.getAttribute("title"),
      null,
      "a title on a disabled control is unreachable by assistive tech; the reason lives in aria-describedby instead",
    );
    const describedBy = send.getAttribute("aria-describedby");
    assert.ok(describedBy, "Send must explain why it is disabled while the agent runs");
    const reason = document.getElementById(describedBy!);
    assert.ok(reason, "the aria-describedby target must be real, rendered text");
    assert.strictEqual(reason!.textContent, "The agent is working. Stop it to send another message.");
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
    assert.strictEqual(screen.queryByRole("button", { name: /editor context/i }), null);
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

  test("the model control is disabled once the session has started, with a reason for assistive tech", () => {
    renderApp();
    hydrate({ items: [{ id: "u1", ts: 1, role: "user", text: "hi" }] });
    const model = screen.getByLabelText("Model") as HTMLButtonElement;
    assert.strictEqual(model.disabled, true);
    const describedBy = model.getAttribute("aria-describedby");
    assert.ok(describedBy, "a disabled control must not rely on a title attribute for its reason");
    const reason = document.getElementById(describedBy!);
    assert.ok(reason, "the aria-describedby target must be real, rendered text");
    assert.ok(/before the first message/i.test(reason!.textContent ?? ""));
  });
});
