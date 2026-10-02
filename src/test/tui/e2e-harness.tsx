import { testRender } from '@opentui/react/test-utils';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { act } from 'react';
import { bootHost, type Booted } from '../../tui/boot';
import { App } from '../../tui/ui/app';
import { PromptArmContext } from '../../tui/ui/prompt-arm';
import { TuiStoreProvider } from '../../tui/ui/store';
import type { TuiTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { TuiThemeProvider } from '../../tui/ui/tui-theme';
import { actEnv, KEY_ALIAS } from './harness';

export type Mods = { ctrl?: boolean; meta?: boolean; shift?: boolean };

export interface MountBootedOpts {
  home?: string;
  cwd?: string;
  prompt?: string;
  promptArmMs?: number;
  tokens?: TuiTokens;
}

export const until = async (cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) { throw new Error(`until: condition not met within ${ms}ms`); }
    await new Promise((r) => setTimeout(r, 25));
  }
};

export async function makeTmp(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-e2e-')));
}

export async function mountBooted(opts: MountBootedOpts = {}) {
  const ownTmp = opts.home && opts.cwd ? undefined : await makeTmp();
  const home = opts.home ?? path.join(ownTmp as string, 'home');
  const cwd = opts.cwd ?? (ownTmp as string);
  const booted: Booted = await bootHost({
    cwd, home, notify: () => {},
    config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
  });
  actEnv(true);
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <PromptArmContext.Provider value={opts.promptArmMs ?? 0}>
        <TokensProvider tokens={opts.tokens}>
        <TuiThemeProvider>
          <TuiStoreProvider transport={booted.loopback.transport}>
            <App launchCwd={cwd} prompt={opts.prompt} forceNew={false} loginCommands={{}} onQuit={() => {}} />
          </TuiStoreProvider>
        </TuiThemeProvider>
        </TokensProvider>
      </PromptArmContext.Provider>,
      { exitOnCtrlC: false, width: 110, height: 32 },
    );
  });
  actEnv(false);
  const render = async (fn?: () => void | Promise<void>) => {
    actEnv(true);
    try { await act(async () => { await fn?.(); }); } finally { actEnv(false); }
    await setup.renderOnce();
  };
  const settle = async (ms = 100) => { await new Promise((r) => setTimeout(r, ms)); await render(); };
  const frame = () => setup.captureCharFrame();
  const waitFrame = async (cond: (f: string) => boolean, ms = 3000) => {
    try { await until(async () => { await render(); return cond(frame()); }, ms); }
    catch (e) { throw new Error(`${(e as Error).message}
${frame()}`); }
  };
  await settle();
  let destroyed = false;
  return {
    booted, home, cwd, settle, frame, waitFrame,
    press: (k: string, mods?: Mods) => render(() => { setup.mockInput.pressKey(KEY_ALIAS[k] ?? k, mods); }),
    type: (t: string) => render(async () => { await setup.mockInput.typeText(t); }),
    destroy: async () => {
      if (destroyed) { return; }
      destroyed = true;
      actEnv(true);
      act(() => { setup.renderer.destroy(); });
      actEnv(false);
      await booted.shutdown();
      if (ownTmp) { await fs.rm(ownTmp, { recursive: true, force: true }); }
    },
  };
}
