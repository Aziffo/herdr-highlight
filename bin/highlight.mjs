import { parseColor } from '../lib/colors.mjs';
import { readContext, runtimeFromEnv, targetFromContext } from '../lib/context.mjs';
import { HerdrClient } from '../lib/herdr.mjs';
import { HighlightStore } from '../lib/store.mjs';
import { reapply } from '../lib/metadata.mjs';
import { runPicker } from '../lib/picker.mjs';

async function main(args, env) {
  const [command, kind, value] = args;
  if (!['set', 'open', 'pick', 'restore', 'event', 'list'].includes(command)) throw new Error('Unknown highlight command');
  const runtime = runtimeFromEnv(env);
  const client = new HerdrClient(env);
  const context = ['set', 'open', 'pick'].includes(command) ? readContext(env, command === 'pick') : null;
  const color = command === 'set' ? parseColor(value) : null;
  const target = context ? targetFromContext(kind, context, client) : null;
  if (command === 'open') { client.openPicker(target); return; }
  const store = new HighlightStore(runtime.stateDir, runtime.namespace);
  try {
    if (command === 'set') store.set(target, color);
    if (command === 'pick') {
      const result = await runPicker(target, store.get(kind, target.id));
      if (result.cancelled) return;
      // A popup can outlive its target. Never redirect the choice to current focus.
      store.set(targetFromContext(kind, context, client), result.color);
    }
    if (command === 'event') {
      if (!env.HERDR_PLUGIN_EVENT_JSON) throw new Error('Missing HERDR_PLUGIN_EVENT_JSON');
      store.removeClosed(JSON.parse(env.HERDR_PLUGIN_EVENT_JSON));
    }
    const result = command === 'list' ? store.snapshot() : reapply(client, store);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { store.close(); }
}

try { await main(process.argv.slice(2), process.env); }
catch (error) { process.stderr.write(`Highlight: ${error.message}\n`); process.exitCode = 1; }
