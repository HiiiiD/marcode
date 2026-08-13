import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension', () => {
  test('activates and registers the panel view', async () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.hiiiid-code');
    assert.ok(ext, 'extension should be found');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('view container is contributed to the activity bar', () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.hiiiid-code');
    const containers = ext!.packageJSON.contributes.viewsContainers.activitybar;
    assert.strictEqual(containers.length, 1);
    assert.strictEqual(containers[0].id, 'hiiiid-code');
  });
});
