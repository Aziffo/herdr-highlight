import { COLORS } from './colors.mjs';

const choices = [{ key: null, label: 'None' }, ...COLORS];
const safeText = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');

export class PickerInput {
  pending = '';

  feed(chunk) {
    this.pending += chunk;
    const events = [];
    while (this.pending) {
      if (this.pending.startsWith('\x1b')) {
        if (this.pending.length === 1) break;
        if (this.pending[1] === '[' || this.pending[1] === 'O') {
          const match = this.pending.match(/^\x1b(?:\[[0-9;<:?]*|O)([@-~])/);
          if (!match) {
            if (this.pending.length > 128) this.pending = '';
            break;
          }
          const escape = match[0];
          this.pending = this.pending.slice(escape.length);
          if (escape === '\x1b[A' || escape === '\x1bOA') events.push({ type: 'move', delta: -1 });
          if (escape === '\x1b[B' || escape === '\x1bOB') events.push({ type: 'move', delta: 1 });
          const mouse = escape.match(/^\x1b\[<0;(\d+);(\d+)M$/);
          if (mouse) events.push({ type: 'click', x: Number(mouse[1]), y: Number(mouse[2]) });
          continue;
        }
        // Consume an Alt chord together; its digit must not become a selection.
        this.pending = this.pending.slice(2);
        continue;
      }
      const character = this.pending[0];
      this.pending = this.pending.slice(1);
      if (character === '\r' || character === '\n') events.push({ type: 'confirm' });
      else if (character === '\x03') events.push({ type: 'cancel' });
      else if (/^[0-8]$/.test(character)) events.push({ type: 'select', index: Number(character) });
    }
    return events;
  }

  flushEscape() {
    if (this.pending !== '\x1b') return [];
    this.pending = '';
    return [{ type: 'cancel' }];
  }
}

export function pickerFrame(target, active, selected, columns, height) {
  const width = Math.max(1, columns - 1);
  const visible = Math.max(1, Math.min(9, height - 6));
  const start = Math.min(Math.max(0, selected - visible + 1), 9 - visible);
  const lines = ['Highlight', `${safeText(target.kind)} ${safeText(target.id)}`,
    safeText(target.label), ''];
  const rows = new Map();
  let text = '\x1b[0m\x1b[H\x1b[2J';
  for (const line of lines) text += `${line.slice(0, width)}\r\n`;
  for (let index = start; index < start + visible; index++) {
    const choice = choices[index];
    rows.set(5 + index - start, index);
    const swatch = choice.ansiBackground ? `\x1b[${choice.ansiBackground}m  \x1b[0m` : '  ';
    const label = `${index} ${choice.label}${choice.key === active ? ' ✓' : ''}`.slice(0, Math.max(1, width - 5));
    const focus = index === selected ? '\x1b[7m' : '';
    text += `${focus}${index === selected ? '›' : ' '} ${swatch}${focus} ${label}\x1b[0m\r\n`;
  }
  text += `\r\n${'↑↓ Enter / 0–8 choose · Esc cancel'.slice(0, width)}`;
  return { text, rows };
}

export function runPicker(target, active, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('The picker needs a terminal; invoke a picker action inside Herdr');
  return new Promise(resolve => {
    const parser = new PickerInput();
    let selected = Math.max(0, choices.findIndex(choice => choice.key === active));
    let frame;
    let timer;
    let finished = false;
    const wasRaw = input.isRaw;
    function draw() {
      frame = pickerFrame(target, active, selected, output.columns ?? 48, output.rows ?? 17);
      output.write(frame.text);
    }
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      output.off('resize', draw);
      process.off('SIGTERM', onEnd);
      process.off('SIGHUP', onEnd);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      output.write('\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h');
      resolve(result);
    }
    function handle(events) {
      for (const event of events) {
        if (finished) return;
        if (event.type === 'cancel') return finish({ cancelled: true });
        if (event.type === 'move') { selected = (selected + event.delta + 9) % 9; draw(); }
        if (event.type === 'confirm') return finish({ color: choices[selected].key });
        if (event.type === 'select') return finish({ color: choices[event.index].key });
        if (event.type === 'click' && event.x > 0 && event.x < (output.columns ?? 48) && frame.rows.has(event.y)) {
          return finish({ color: choices[frame.rows.get(event.y)].key });
        }
      }
    }
    function onData(chunk) {
      clearTimeout(timer);
      handle(parser.feed(chunk.toString('utf8')));
      if (!finished) timer = setTimeout(() => handle(parser.flushEscape()), 60);
    }
    function onEnd() { finish({ cancelled: true }); }
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('end', onEnd);
    output.on('resize', draw);
    process.on('SIGTERM', onEnd);
    process.on('SIGHUP', onEnd);
    output.write('\x1b[?25l\x1b[?1000h\x1b[?1006h');
    draw();
  });
}
