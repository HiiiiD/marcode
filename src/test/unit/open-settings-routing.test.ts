import * as assert from 'assert';
import { routeOpenSettings } from '../../host/settings-routing';

suite('routeOpenSettings', () => {
  test('a moved setting opens the config file', () => {
    assert.strictEqual(routeOpenSettings('marcode.enabledProviders marcode.providerInstances'), 'config-file');
  });
  test('a pure-UI setting stays in VS Code', () => {
    assert.strictEqual(routeOpenSettings('marcode.showCacheTimer'), 'vscode');
    assert.strictEqual(routeOpenSettings('marcode.debug'), 'vscode');
  });
});
