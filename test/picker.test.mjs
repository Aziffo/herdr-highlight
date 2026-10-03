import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PickerInput, pickerFrame, runPicker } from '../lib/picker.mjs';

test('picker parses arrows, confirmation, cancellation and numbered selections', () => {
  const input = new PickerInput();
  assert.deepEqual(input.feed('\x1b[A\x1b[B\r'), [{ type: 'move', delta: -1 }, { type: 'move', delta: 1 }, { type: 'confirm' }]);
  assert.deepEqual(input.feed('08\x03'), [{ type: 'select', index: 0 }, { type: 'select', index: 8 }, { type: 'cancel' }]);
  assert.deepEqual(input.feed('\x1b'), []);
  assert.deepEqual(input.flushEscape(), [{ type: 'cancel' }]);
});

test('split mouse escape sequences never select a color from their digits', () => {
  const input = new PickerInput();
  assert.deepEqual(input.feed('\x1b[<0;12;'), []);
  assert.deepEqual(input.feed('8M'), [{ type: 'click', x: 12, y: 8 }]);
  assert.deepEqual(input.feed('\x1b[<0;12;8m'), []);
  assert.deepEqual(input.feed('\x1b[999~'), []);
});

test('frame marks active color, clips tiny layouts, and exposes only visible mouse rows', () => {
  const frame = pickerFrame({ kind: 'tab', id: 'w2:t3', label: 'target\x1b[31m' }, 'teal', 6, 46, 17);
  assert.match(frame.text, /Teal.*✓/);
  assert.equal(frame.rows.get(5), 0);
  assert.equal(frame.rows.get(13), 8);
  assert.doesNotMatch(frame.text, /target\x1b\[31m/);
  const tiny = pickerFrame({ kind: 'workspace', id: 'w1' }, null, 8, 12, 7);
  assert.ok([...tiny.rows.keys()].every(row => row <= 5));
  assert.ok([...tiny.rows.values()].includes(8));
});

function fakeTerminal() {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; },
    resume() { this.paused = false; }, pause() { this.paused = true; } });
  const output = new EventEmitter();
  Object.assign(output, { isTTY: true, columns: 48, rows: 17, text: '', write(text) { this.text += text; } });
  return { input, output };
}

test('picker selection restores raw mode, mouse mode, cursor, and all listeners', async () => {
  const { input, output } = fakeTerminal();
  const signals = process.listenerCount('SIGTERM');
  const result = runPicker({ kind: 'tab', id: 'w2:t1' }, 'blue', input, output);
  assert.equal(input.isRaw, true);
  output.emit('resize');
  input.emit('data', Buffer.from('\x1b[<0;8;6M'));
  assert.deepEqual(await result, { color: 'red' });
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(process.listenerCount('SIGTERM'), signals);
  assert.match(output.text, /\x1b\[\?1000l\x1b\[\?1006l\x1b\[\?25h$/);
});

test('picker cancellation never returns a color and preserves an already raw terminal', async () => {
  const { input, output } = fakeTerminal();
  input.isRaw = true;
  const result = runPicker({ kind: 'workspace', id: 'w2' }, 'green', input, output);
  input.emit('data', Buffer.from('\x1b'));
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(input.isRaw, true);
  assert.equal(input.listenerCount('end'), 0);
});
