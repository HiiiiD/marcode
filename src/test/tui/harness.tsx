import { testRender } from '@opentui/react/test-utils';
import { act, type ReactNode } from 'react';
import { createLoopback } from '../../client-core/loopback-transport';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';
import { PromptArmContext } from '../../tui/ui/prompt-arm';
import { TuiStoreProvider } from '../../tui/ui/store';
import { catalog, singlePaneLayout, snapshot, summary } from '../fixtures/protocol';

// testRender flips this to false on destroy, so every mount must switch it back on.
export const actEnv = (on: boolean) => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on; };
actEnv(true);

// mockInput takes KeyCodes names (RETURN, ARROW_UP) or literal characters, not the lowercase key.name the app sees.
export const KEY_ALIAS: Record<string, string> = {
  return: 'RETURN', linefeed: 'LINEFEED', tab: 'TAB', escape: 'ESCAPE', backspace: 'BACKSPACE', delete: 'DELETE',
  up: 'ARROW_UP', down: 'ARROW_DOWN', left: 'ARROW_LEFT', right: 'ARROW_RIGHT', home: 'HOME', end: 'END',
  pageup: '\u001B[5~', pagedown: '\u001B[6~', space: ' ',
};

export interface Mounted {
  setup: Awaited<ReturnType<typeof testRender>>;
  posted: WebviewToHost[];
  fromHost(...msgs: HostToWebview[]): Promise<void>;
  frame(): string;
  press(name: string, mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean }): Promise<void>;
  type(text: string): Promise<void>;
  /** Delivers every key inside one act batch, with no render in between (type-ahead, paste). */
  pressMany(keys: string[]): Promise<void>;
  destroy(): void;
}

export interface MountOpts {
  /** Prompts ignore keys for this long after they appear; 0 here so tests can answer at once. */
  promptArmMs?: number;
}

export async function mount(ui: ReactNode, size = { width: 100, height: 30 }, opts: MountOpts = {}): Promise<Mounted> {
  const posted: WebviewToHost[] = [];
  const loop = createLoopback((m) => { posted.push(m); });
  actEnv(true);
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    // main.tsx runs with exitOnCtrlC off; the test renderer would otherwise destroy itself on Ctrl+C.
    setup = await testRender(
      <PromptArmContext.Provider value={opts.promptArmMs ?? 0}>
        <TuiStoreProvider transport={loop.transport}>{ui}</TuiStoreProvider>
      </PromptArmContext.Provider>,
      { exitOnCtrlC: false, ...size },
    );
  });
  await setup.renderOnce();
  actEnv(true);
  const settle = async (fn: () => void | Promise<void>) => {
    await act(async () => { await fn(); });
    await setup.renderOnce();
  };
  return {
    setup,
    posted,
    fromHost: (...msgs) => settle(() => { for (const m of msgs) { loop.deliver(m); } }),
    frame: () => setup.captureCharFrame(),
    press: (name, mods) => settle(() => { setup.mockInput.pressKey(KEY_ALIAS[name] ?? name, mods); }),
    type: (text) => settle(async () => { await setup.mockInput.typeText(text); }),
    pressMany: (keys) => settle(() => { for (const k of keys) { setup.mockInput.pressKey(KEY_ALIAS[k] ?? k); } }),
    destroy: () => { actEnv(true); act(() => { setup.renderer.destroy(); }); },
  };
}

export function hydrateMsg(over: Partial<Extract<HostToWebview, { t: 'hydrate' }>> = {}): HostToWebview {
  const s = snapshot('s1');
  return {
    t: 'hydrate', sessions: [summary('s1')], layout: singlePaneLayout('s1'), snapshots: [s],
    catalog: catalog(), unavailable: [], probing: false, usage: {}, ...over,
  };
}
