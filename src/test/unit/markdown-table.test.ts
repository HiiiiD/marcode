import * as assert from 'assert';
import type { Element } from 'hast';
import { tableRows, toCsv, toTsv } from '../../webview/components/markdown-table';

function cell(tagName: 'th' | 'td', text: string): Element {
  return { type: 'element', tagName, properties: {}, children: [{ type: 'text', value: text }] };
}

function row(tagName: 'th' | 'td', values: string[]): Element {
  return { type: 'element', tagName: 'tr', properties: {}, children: values.map((v) => cell(tagName, v)) };
}

const TABLE: Element = {
  type: 'element',
  tagName: 'table',
  properties: {},
  children: [
    { type: 'element', tagName: 'thead', properties: {}, children: [row('th', ['Task', 'State'])] },
    {
      type: 'element',
      tagName: 'tbody',
      properties: {},
      children: [
        row('td', ['1 Dependency', 'complete']),
        row('td', ['2 Session', 'pending']),
      ],
    },
  ],
};

suite('tableRows', () => {
  test('reads header and body rows in order', () => {
    assert.deepStrictEqual(tableRows(TABLE), [
      ['Task', 'State'],
      ['1 Dependency', 'complete'],
      ['2 Session', 'pending'],
    ]);
  });
});

suite('toTsv', () => {
  test('tab-separates cells, newline-separates rows', () => {
    assert.strictEqual(
      toTsv([['Task', 'State'], ['a', 'b']]),
      'Task\tState\na\tb',
    );
  });

  test('strips embedded tabs and newlines from a cell', () => {
    assert.strictEqual(toTsv([['a\tb', 'c\nd']]), 'a b\tc d');
  });
});

suite('toCsv', () => {
  test('comma-separates cells, CRLF-separates rows', () => {
    assert.strictEqual(
      toCsv([['Task', 'State'], ['a', 'b']]),
      'Task,State\r\na,b',
    );
  });

  test('quotes a cell containing a comma, quote, or newline', () => {
    assert.strictEqual(toCsv([['a,b', 'say "hi"', 'x\ny']]), '"a,b","say ""hi""","x\ny"');
  });
});
