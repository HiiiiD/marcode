import * as assert from 'node:assert';
import { scrubDaemonEnv } from '../../daemon/daemon-env';

suite('daemon env', () => {
  test('ELECTRON_RUN_AS_NODE is removed so agents can launch Electron apps, everything else is kept', () => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin', HOME: '/h' };
    scrubDaemonEnv(env);
    assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h' });
  });
});
