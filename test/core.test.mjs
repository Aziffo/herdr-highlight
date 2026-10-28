import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { COLORS, parseColor } from '../lib/colors.mjs';
import { runtimeFromEnv, targetFromContext } from '../lib/context.mjs';
import { HighlightStore } from '../lib/store.mjs';
import { planMetadata, reapply } from '../lib/metadata.mjs';
import { readContext } from '../lib/context.mjs';
import { HerdrClient } from '../lib/herdr.mjs';

test('fixed palette accepts only the eight colors and None', () => {
  assert.deepEqual(COLORS.map(c => c.key), ['red', 'peach', 'yellow', 'green', 'teal', 'blue', 'mauve', 'gray']);
  for (const color of COLORS) assert.equal(parseColor(color.key), color.key);
  assert.equal(parseColor('none'), null);
  assert.throws(() => parseColor('#ff0000'), /color/);
  assert.throws(() => parseColor('purple'), /color/);
});

test('socket namespaces isolate sessions, normalize Windows pipes, and require injected runtime', () => {
  const env = { HERDR_BIN_PATH: '/bin/herdr', HERDR_PLUGIN_STATE_DIR: '/state', HERDR_SOCKET_PATH: '/a.sock' };
  assert.notEqual(runtimeFromEnv(env).namespace, runtimeFromEnv({ ...env, HERDR_SOCKET_PATH: '/b.sock' }).namespace);
  assert.equal(runtimeFromEnv({ ...env, HERDR_SOCKET_PATH: '\\\\.\\pipe\\Herdr-Test' }, 'win32').namespace,
    runtimeFromEnv({ ...env, HERDR_SOCKET_PATH: '\\\\.\\pipe\\herdr-test' }, 'win32').namespace);
  assert.throws(() => runtimeFromEnv({ ...env, HERDR_SOCKET_PATH: '' }), /HERDR_SOCKET_PATH/);
});

test('actions use supplied resource IDs rather than focus and reject inconsistent tab context', () => {
  const seen = [];
  const client = { get(kind, id) {
    seen.push([kind, id]);
    return kind === 'tab' ? { tab_id: id, workspace_id: 'w2', label: 'other tab' }
      : { workspace_id: id, label: 'other workspace' };
  } };
  assert.equal(targetFromContext('workspace', { workspace_id: 'w2', tab_id: 'w1:t1' }, client).id, 'w2');
  assert.equal(targetFromContext('tab', { workspace_id: 'w2', tab_id: 'w2:t3' }, client).id, 'w2:t3');
  assert.throws(() => targetFromContext('tab', { workspace_id: 'w1', tab_id: 'w2:t3' }, client), /workspace/);
  assert.throws(() => targetFromContext('workspace', {}, client), /workspace_id/);
  assert.deepEqual(seen.slice(0, 2), [['workspace', 'w2'], ['tab', 'w2:t3']]);
});

test('SQLite state survives reopening and isolates tab/workspace and endpoint identity', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new HighlightStore(dir, 'local-a');
  store.set({ kind: 'workspace', id: 'w1', workspaceId: 'w1' }, 'red');
  store.set({ kind: 'tab', id: 'w1:t1', workspaceId: 'w1' }, 'blue');
  const sequence = store.snapshot().seq;
  store.close();
  store = new HighlightStore(dir, 'local-a');
  assert.equal(store.get('workspace', 'w1'), 'red');
  assert.equal(store.get('tab', 'w1:t1'), 'blue');
  assert.ok(store.snapshot().seq > sequence);
  store.set({ kind: 'workspace', id: 'w1', workspaceId: 'w1' }, null);
  assert.equal(store.get('workspace', 'w1'), null);
  assert.equal(store.get('tab', 'w1:t1'), 'blue');
  store.close();
  const other = new HighlightStore(dir, 'ssh-b');
  assert.equal(other.get('tab', 'w1:t1'), null);
  other.close();
});

test('closing a workspace removes its tab records only in the current endpoint', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = new HighlightStore(dir, 'a');
  const b = new HighlightStore(dir, 'b');
  for (const store of [a, b]) {
    store.set({ kind: 'workspace', id: 'w1', workspaceId: 'w1' }, 'teal');
    store.set({ kind: 'tab', id: 'w1:t1', workspaceId: 'w1' }, 'gray');
  }
  a.removeClosed({ event: 'workspace_closed', data: { workspace_id: 'w1' } });
  assert.equal(a.snapshot().rows.length, 0);
  assert.equal(b.snapshot().rows.length, 2);
  a.close(); b.close();
});

test('metadata projection keeps native labels untouched and updates only owned display tokens', () => {
  const snapshot = {
    workspaces: [{ workspace_id: 'w1', tokens: { unrelated: 'keep' } }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1 }],
    panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', tokens: {} }],
  };
  const rows = [{ kind: 'workspace', resource_id: 'w1', workspace_id: 'w1', color: 'teal' },
    { kind: 'tab', resource_id: 'w1:t1', workspace_id: 'w1', color: 'blue' }];
  const patches = planMetadata(snapshot, rows);
  assert.deepEqual(patches.map(p => p.kind), ['workspace', 'pane']);
  assert.deepEqual(patches[0].tokens, { highlight_workspace: 'Teal', highlight_tabs: 't1:Blue' });
  assert.deepEqual(patches[1].tokens, { highlight_workspace: 'Teal', highlight_tab: 'Blue', highlight_pane: null });
  assert.equal(snapshot.workspaces[0].tokens.unrelated, 'keep');
  for (const patch of patches) {
    const resource = patch.kind === 'workspace' ? snapshot.workspaces[0] : snapshot.panes[0];
    Object.assign(resource.tokens, patch.tokens);
  }
  assert.deepEqual(planMetadata(snapshot, rows), patches);
  assert.equal(planMetadata(snapshot, [rows[0]])[1].tokens.highlight_tab, null);
});

test('popup uses captured action target even when the host rebuilds its active context', () => {
  const env = {
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', tab_id: 'w1:t1' }),
    HIGHLIGHT_TARGET_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w2', tab_id: 'w2:t3' }),
  };
  assert.equal(readContext(env, true).tab_id, 'w2:t3');
  assert.equal(readContext(env).workspace_id, 'w1');
  assert.throws(() => readContext({ HERDR_PLUGIN_CONTEXT_JSON: 'null' }), /context/);
});

test('report failures preserve saved state for later restore, while closure races are harmless', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HighlightStore(dir, 'a');
  store.set({ kind: 'workspace', id: 'w1', workspaceId: 'w1' }, 'peach');
  const client = {
    snapshot: () => ({ workspaces: [{ workspace_id: 'w1' }], tabs: [], panes: [] }),
    report: () => { throw new Error('disconnected'); },
  };
  assert.throws(() => reapply(client, store), /Saved state retained/);
  assert.equal(store.get('workspace', 'w1'), 'peach');
  client.report = () => { throw Object.assign(new Error('closed'), { code: 'workspace_not_found' }); };
  assert.doesNotThrow(() => reapply(client, store));
  store.close();
});

test('large tab summaries stay within the metadata value limit', () => {
  const tabs = Array.from({ length: 100 }, (_, index) => ({ workspace_id: 'w1', tab_id: `w1:t${index + 1}`, number: index + 1 }));
  const rows = tabs.map(tab => ({ kind: 'tab', resource_id: tab.tab_id, workspace_id: 'w1', color: 'yellow' }));
  const patches = planMetadata({ workspaces: [{ workspace_id: 'w1' }], tabs, panes: [] }, rows);
  assert.ok(patches[0].tokens.highlight_tabs.length <= 80);
  assert.match(patches[0].tokens.highlight_tabs, /more$/);
});

test('a projection paused before a pane move cannot overwrite the newer tab color', () => {
  const tabs = [1, 2].map(number => ({ tab_id: `w1:t${number}`, workspace_id: 'w1', number }));
  const rows = tabs.map((tab, index) => ({ kind: 'tab', resource_id: tab.tab_id, workspace_id: 'w1', color: ['red', 'blue'][index] }));
  let revision = 0;
  const store = { snapshot: () => ({ seq: ++revision, rows }) };
  const topology = tabId => ({ workspaces: [{ workspace_id: 'w1' }], tabs,
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: tabId }] });
  const latest = new Map();
  let moved = false;
  const client = {
    snapshot() {
      if (moved) return topology('w1:t2');
      // Freeze the older list result while another lifecycle invocation finishes.
      const beforeMove = topology('w1:t1');
      moved = true;
      reapply(client, store);
      return beforeMove;
    },
    report(patch, seq) {
      const key = `${patch.kind}:${patch.id}`;
      if (seq > (latest.get(key)?.seq ?? 0)) latest.set(key, { seq, tokens: patch.tokens });
    },
  };
  reapply(client, store);
  assert.equal(latest.get('pane:w1:p1').tokens.highlight_tab, 'Blue');
});

test('independent action processes preserve concurrent records and monotonic revisions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `import { HighlightStore } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    const store = new HighlightStore(process.argv[1], 'endpoint');
    const id = 'w' + process.argv[2];
    for (let index = 0; index < 10; index++) store.set({ kind: 'workspace', id, workspaceId: id }, 'mauve');
    store.snapshot(); store.close();`;
  await Promise.all([1, 2, 3].map(index => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, String(index)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const store = new HighlightStore(dir, 'endpoint');
  try {
    const saved = store.snapshot();
    assert.equal(saved.rows.length, 3);
    assert.ok(saved.rows.every(row => row.color === 'mauve'));
    assert.equal(saved.seq, 4);
  } finally { store.close(); }
});

test('first initialization waits for a temporary reader preventing the WAL transition', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-initialize-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reader = new DatabaseSync(join(dir, 'highlights.sqlite'));
  reader.exec('BEGIN; PRAGMA user_version;');
  let release;
  let stderr = '';
  const script = `import { HighlightStore } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    process.stdout.write('ready');
    const store = new HighlightStore(process.argv[1], 'endpoint');
    store.set({ kind: 'workspace', id: 'w1', workspaceId: 'w1' }, 'teal'); store.close();`;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.once('data', () => { release = setTimeout(() => reader.exec('COMMIT'), 250); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    });
  } finally { clearTimeout(release); reader.close(); }
  const store = new HighlightStore(dir, 'endpoint');
  try { assert.equal(store.get('workspace', 'w1'), 'teal'); } finally { store.close(); }
});

test('pane-move close data prunes source workspace/tab records without crossing endpoints', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-move-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = new HighlightStore(dir, 'a');
  const b = new HighlightStore(dir, 'b');
  for (const store of [a, b]) {
    store.set({ kind: 'workspace', id: 'w1', workspaceId: 'w1' }, 'teal');
    store.set({ kind: 'tab', id: 'w1:t1', workspaceId: 'w1' }, 'gray');
    store.set({ kind: 'workspace', id: 'w2', workspaceId: 'w2' }, 'blue');
  }
  a.removeClosed({ event: 'pane_moved', data: { closed_workspace_id: 'w1', closed_tab_id: 'w1:t1' } });
  assert.equal(a.get('workspace', 'w1'), null);
  assert.equal(a.get('tab', 'w1:t1'), null);
  assert.equal(a.get('workspace', 'w2'), 'blue');
  assert.equal(b.snapshot().rows.length, 3);
  a.close(); b.close();
});


test('identically named agents in one tab keep independent pane choices', () => {
  const panes = ['w1:p1', 'w1:p2'].map(pane_id => ({ pane_id, tab_id: 'w1:t1', workspace_id: 'w1', label: 'simpleLoginlocal' }));
  const client = { get: (_, id) => panes.find(pane => pane.pane_id === id) };
  const target = targetFromContext('pane', { focused_pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }, client);
  assert.equal(target.id, 'w1:p2');
  assert.throws(() => targetFromContext('pane', { focused_pane_id: 'w1:p2', tab_id: 'w1:t2' }, client), /tab/);
  assert.throws(() => targetFromContext('pane', { focused_pane_id: 'w1:p2', workspace_id: 'w2' }, client), /workspace/);
  assert.throws(() => targetFromContext('pane', { tab_id: 'w1:t1' }, client), /pane_id/);
  const patches = planMetadata({ workspaces: [], tabs: [], panes }, [
    { kind: 'pane', resource_id: target.id, workspace_id: 'w1', color: 'red' },
  ]);
  assert.equal(patches[0].tokens.highlight_pane, null);
  assert.equal(patches[1].tokens.highlight_pane, 'Red');
});

test('v1 migration preserves colors and counters; pane moves and closes stay endpoint-local', t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-highlight-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(join(dir, 'highlights.sqlite'));
  old.exec(`CREATE TABLE endpoints (endpoint TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE highlights (endpoint TEXT, kind TEXT CHECK(kind IN ('workspace','tab')),
      resource_id TEXT, workspace_id TEXT, color TEXT, PRIMARY KEY(endpoint,kind,resource_id));
    INSERT INTO endpoints VALUES ('a',42);
    INSERT INTO highlights VALUES ('a','tab','w1:t1','w1','blue');
    PRAGMA user_version=1;`);
  old.close();
  const a = new HighlightStore(dir, 'a');
  const b = new HighlightStore(dir, 'b');
  t.after(() => { a.close(); b.close(); });
  assert.equal(a.get('tab', 'w1:t1'), 'blue');
  assert.equal(a.snapshot().seq, 43);
  for (const store of [a, b]) store.set({ kind: 'pane', id: 'w1:p1', workspaceId: 'w1' }, 'red');
  a.removeClosed({ event: 'pane_moved', data: { previous_pane_id: 'w1:p1',
    pane: { pane_id: 'w2:p3', workspace_id: 'w2' }, closed_workspace_id: 'w1' } });
  assert.equal(a.get('pane', 'w1:p1'), null);
  assert.equal(a.get('pane', 'w2:p3'), 'red');
  assert.equal(b.get('pane', 'w1:p1'), 'red');
  a.removeClosed({ event: 'pane_closed', data: { pane_id: 'w2:p3' } });
  assert.equal(a.get('pane', 'w2:p3'), null);
});


test('agent picker captures the exact pane even if focus changes while it is open', () => {
  const client = new HerdrClient({});
  let args;
  client.run = value => { args = value; };
  client.openPicker({ kind: 'pane', id: 'w1:p2', workspaceId: 'w1' });
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'pane-picker');
  const captured = args[args.indexOf('--env') + 1].split('=').slice(1).join('=');
  const context = readContext({ HIGHLIGHT_TARGET_CONTEXT_JSON: captured,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p1' }) }, true);
  assert.equal(context.focused_pane_id, 'w1:p2');
});
