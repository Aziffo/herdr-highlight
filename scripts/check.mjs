import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const directory of ['bin', 'lib', 'scripts', 'test']) {
  for (const file of readdirSync(directory).filter(name => name.endsWith('.mjs'))) {
    const path = join(directory, file);
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    const source = readFileSync(path, 'utf8');
    if (check.status !== 0 || /\t|[ \t]+$/m.test(source) || !source.endsWith('\n')) {
      console.error(`${path}: ${check.stderr || 'tabs, trailing whitespace or missing final newline'}`);
      failed = true;
    }
  }
}
process.exitCode = failed ? 1 : 0;
