import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Root hooks: hosts built over a bare temp dir would otherwise default to a shared account.sqlite above os.tmpdir().
let sandbox: string;
suiteSetup(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-acct-sandbox-'));
  process.env.MARCODE_ACCOUNT_CACHE = path.join(sandbox, 'account.sqlite');
});
suiteTeardown(() => {
  delete process.env.MARCODE_ACCOUNT_CACHE;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
