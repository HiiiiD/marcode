import * as assert from 'node:assert';
import * as core from '../../client-core/reducer';
import * as coreTool from '../../client-core/tool-render';
import * as oldReducer from '../../webview/reducer';
import * as oldTool from '../../webview/components/tool-render';
import * as oldLayout from '../../webview/components/layout-tree';
import * as coreLayout from '../../client-core/layout-tree';

suite('client-core re-exports', () => {
  test('the old webview paths expose the same functions as client-core', () => {
    assert.strictEqual(oldReducer.reduce, core.reduce);
    assert.strictEqual(oldReducer.initialState, core.initialState);
    assert.strictEqual(oldTool.describeTool, coreTool.describeTool);
    assert.strictEqual(oldLayout.leafSessionIds, coreLayout.leafSessionIds);
  });
});
