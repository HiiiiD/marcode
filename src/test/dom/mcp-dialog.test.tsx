import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as assert from "assert";
import type { McpPanel, McpServerStatus } from "../../protocol/messages";
import { posted, renderApp, sendFromHost } from "./harness";
import { hydrate } from "./session-header.test";

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CLAUDE_CAPS = { reconnect: "per-server" as const, signIn: false, sse: true, workingDirectory: false };
const OPENCODE_CAPS = { reconnect: "per-server" as const, signIn: true, sse: false, workingDirectory: true };

function panel(over: Partial<McpPanel> = {}): McpPanel {
  return {
    capabilities: CLAUDE_CAPS,
    targets: { repo: { path: "E:\\repo\\.mcp.json" }, global: { path: "C:\\Users\\m\\.claude.json" } },
    pending: [],
    restarting: false,
    ...over,
  };
}

const SERVERS: McpServerStatus[] = [
  { name: "shadcn", state: "connected", toolCount: 3, origin: "repo" },
  { name: "figma", state: "failed", error: "InvalidHTTPResponse", origin: "global" },
  { name: "blender", state: "connected", toolCount: 18, origin: "repo-private" },
];

async function openMcp(p: McpPanel = panel(), servers: McpServerStatus[] = SERVERS) {
  renderApp();
  hydrate();
  await userEvent.type(screen.getByLabelText("Message"), "/mcp{Enter}");
  await settle();
  sendFromHost({ t: "session-mcp", id: "a", servers }, { t: "mcp-panel", id: "a", panel: p });
  await settle();
  return within(screen.getByRole("dialog"));
}

suite("MCP dialog", () => {
  test("typing /mcp posts mcp-open and opens the dialog; nothing goes to the agent", async () => {
    const dialog = await openMcp();
    assert.strictEqual(posted().some((m) => m.t === "send"), false);
    assert.strictEqual(posted().some((m) => m.t === "mcp-open" && m.id === "a"), true);
    assert.strictEqual(dialog.getByText("MCP servers").textContent, "MCP servers");
  });

  test("the session header has no MCP button any more", () => {
    renderApp();
    hydrate();
    assert.strictEqual(screen.queryByRole("button", { name: /MCP servers for/ }) === null, true);
  });

  test("rows render problems first with their scope badges", async () => {
    const dialog = await openMcp();
    const names = dialog.getAllByRole("listitem").map((li) => li.getAttribute("data-server"));
    assert.deepStrictEqual(names, ["figma", "blender", "shadcn"]);
    assert.strictEqual(dialog.getByText("repo · private").textContent, "repo · private");
    assert.strictEqual(dialog.getByText("3 servers · 1 failing").textContent, "3 servers · 1 failing");
  });

  test("delete confirms with the file path, then posts mcp-remove with the origin", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Delete shadcn" }));
    assert.strictEqual(dialog.getByText(/E:\\repo\\\.mcp\.json/).textContent?.includes("E:\\repo\\.mcp.json"), true);
    await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
    assert.deepStrictEqual(posted().at(-1), { t: "mcp-remove", id: "a", name: "shadcn", origin: "repo" });
  });

  test("reconnect posts mcp-reconnect", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Reconnect figma" }));
    assert.deepStrictEqual(posted().at(-1), { t: "mcp-reconnect", id: "a", name: "figma" });
  });

  test("the restart banner appears for pending changes and posts restart-session", async () => {
    const dialog = await openMcp(panel({ pending: [{ name: "new", origin: "repo", change: "added" }] }));
    assert.strictEqual(dialog.getByText("Config changed. Restart to load it.").textContent, "Config changed. Restart to load it.");
    assert.strictEqual(dialog.getByText("added · restart to load").textContent, "added · restart to load");
    await userEvent.click(dialog.getByRole("button", { name: "Restart session" }));
    assert.deepStrictEqual(posted().at(-1), { t: "restart-session", id: "a" });
  });

  test("no pending change, no banner", async () => {
    const dialog = await openMcp();
    assert.strictEqual(dialog.queryByRole("button", { name: "Restart session" }) === null, true);
  });

  test("a panel error is shown", async () => {
    const dialog = await openMcp(panel({ error: "disk full" }));
    assert.strictEqual(dialog.getByText("disk full").textContent, "disk full");
  });

  test("an empty list says so and still offers Add server", async () => {
    const dialog = await openMcp(panel(), []);
    assert.strictEqual(dialog.getByText("No MCP servers yet.").textContent, "No MCP servers yet.");
    assert.strictEqual(dialog.queryByRole("button", { name: "Add server" }) !== null, true);
  });

  test("stdio add splits the command and posts mcp-add to the repo", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await userEvent.type(dialog.getByLabelText("Name"), "blender2");
    await userEvent.type(dialog.getByLabelText("Command"), "uv --directory E:\\b run blender-mcp");
    await userEvent.click(dialog.getByRole("button", { name: "Add" }));
    assert.deepStrictEqual(posted().at(-1), {
      t: "mcp-add", id: "a", scope: "repo",
      server: { name: "blender2", transport: "stdio", command: "uv", args: ["--directory", "E:\\b", "run", "blender-mcp"], env: {} },
    });
  });

  test("a name already in the target scope is refused inline", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await userEvent.type(dialog.getByLabelText("Name"), "shadcn");
    await userEvent.type(dialog.getByLabelText("Command"), "npx x");
    await userEvent.click(dialog.getByRole("button", { name: "Add" }));
    assert.strictEqual(posted().some((m) => m.t === "mcp-add"), false);
    assert.strictEqual(dialog.getByText(/already exists there/).textContent?.length !== 0, true);
  });

  test("Claude gets the working-directory hint, OpenCode the field", async () => {
    const claude = await openMcp();
    await userEvent.click(claude.getByRole("button", { name: "Add server" }));
    assert.strictEqual(claude.queryByLabelText("Working directory") === null, true);
    assert.strictEqual(claude.getByText(/use the tool's own flag/).textContent?.length !== 0, true);
  });

  test("OpenCode shows the working directory field and no SSE", async () => {
    const dialog = await openMcp(panel({ capabilities: OPENCODE_CAPS }));
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    assert.strictEqual(dialog.queryByLabelText("Working directory") !== null, true);
    assert.strictEqual(dialog.queryByRole("tab", { name: "SSE" }) === null, true);
  });

  test("HTTP add posts url and headers", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await userEvent.click(dialog.getByRole("tab", { name: "HTTP" }));
    await userEvent.type(dialog.getByLabelText("Name"), "h");
    await userEvent.type(dialog.getByLabelText("URL"), "https://h/mcp");
    await userEvent.click(dialog.getByRole("radio", { name: "Global" }));
    await userEvent.click(dialog.getByRole("button", { name: "Add" }));
    assert.deepStrictEqual(posted().at(-1), {
      t: "mcp-add", id: "a", scope: "global", server: { name: "h", transport: "http", url: "https://h/mcp", headers: {} },
    });
  });

  test("paste JSON with several servers shows the one-at-a-time error", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await userEvent.click(dialog.getByRole("tab", { name: "Paste JSON" }));
    await userEvent.click(dialog.getByLabelText("JSON"));
    await userEvent.paste('{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}');
    await userEvent.click(dialog.getByRole("button", { name: "Use this" }));
    assert.strictEqual(dialog.getByText("Found 2 servers (a, b). Paste one at a time.").textContent?.length !== 0, true);
  });

  test("paste JSON with one server fills the stdio form", async () => {
    const dialog = await openMcp();
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await userEvent.click(dialog.getByRole("tab", { name: "Paste JSON" }));
    await userEvent.click(dialog.getByLabelText("JSON"));
    await userEvent.paste('{"mcpServers":{"shad":{"command":"npx","args":["shadcn@latest","mcp"]}}}');
    await userEvent.click(dialog.getByRole("button", { name: "Use this" }));
    assert.strictEqual((dialog.getByLabelText("Name") as HTMLInputElement).value, "shad");
    assert.strictEqual((dialog.getByLabelText("Command") as HTMLInputElement).value, "npx shadcn@latest mcp");
  });

  test("an unavailable global target is disabled with its reason", async () => {
    const dialog = await openMcp(panel({
      capabilities: OPENCODE_CAPS,
      targets: { repo: { path: "E:\\repo\\opencode.json" }, global: { unavailable: "Inline config, can't add." } },
    }));
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    assert.strictEqual(dialog.getByRole("radio", { name: "Global" }).hasAttribute("data-disabled"), true);
    assert.strictEqual(dialog.getByText("Inline config, can't add.").textContent?.length !== 0, true);
  });
});
