import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { HighlightStore } from '../lib/store.mjs';
import { runtimeFromEnv } from '../lib/context.mjs';

const binary = process.env.HERDR_TEST_BIN;
const pluginRoot = resolve(import.meta.dirname, '..');

async function eventually(probe, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const result = await probe(); if (result) return result; } catch (error) { last = error; }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ''}`);
}

class Endpoint {
  constructor(root, name, sharedState) {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
    this.root = join(root, name);
    mkdirSync(this.root, { recursive: true });
    this.socket = join(this.root, 'api.sock');
    this.env = { ...clean, SHELL: '/bin/sh', TERM: 'xterm-256color',
      XDG_CONFIG_HOME: join(this.root, 'config'), XDG_STATE_HOME: sharedState,
      XDG_DATA_HOME: join(this.root, 'data'), XDG_RUNTIME_DIR: join(this.root, 'runtime'),
      HERDR_CONFIG_PATH: join(this.root, 'config.toml'), HERDR_SOCKET_PATH: this.socket,
      HERDR_CLIENT_SOCKET_PATH: join(this.root, 'client.sock') };
    mkdirSync(this.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(this.env.HERDR_CONFIG_PATH, '[terminal]\nshell = "/bin/sh"\n');
    this.output = '';
    this.serial = 0;
  }

  request(method, params = {}) {
    return new Promise((resolveRequest, reject) => {
      const socket = createConnection(this.socket);
      let text = '';
      socket.setTimeout(5000, () => socket.destroy(new Error(`API timeout: ${method}`)));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`${JSON.stringify({ id: `test:${++this.serial}`, method, params })}\n`));
      socket.on('data', chunk => {
        text += chunk.toString();
        if (!text.includes('\n')) return;
        socket.destroy();
        try {
          const response = JSON.parse(text.split('\n')[0]);
          if (response.error) reject(new Error(`${response.error.code}: ${response.error.message}`));
          else resolveRequest(response.result);
        } catch (error) { reject(error); }
      });
    });
  }

  async start() {
    this.child = spawn(binary, ['server'], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', data => { this.output += data; });
    this.child.stderr.on('data', data => { this.output += data; });
    this.exited = new Promise(resolveExit => this.child.once('exit', resolveExit));
    await eventually(async () => {
      if (this.child.exitCode !== null) throw new Error(`Server exited: ${this.output}`);
      return this.request('workspace.list');
    }, 'isolated server startup');
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    try { await this.request('server.stop'); } catch { /* Server may close the API before its reply. */ }
    await Promise.race([this.exited, delay(8000, undefined, { ref: false }).then(() => this.child.kill('SIGTERM'))]);
    if (this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await this.exited;
    }
  }

  async link() { await this.request('plugin.link', { path: pluginRoot, enabled: true }); }

  async action(action, context = {}, expectedStatus = 'succeeded') {
    const invoked = await this.request('plugin.action.invoke', {
      plugin_id: 'aziffo.highlight', action_id: action, context,
    });
    const log = await eventually(async () => {
      const { logs } = await this.request('plugin.log.list', { plugin_id: 'aziffo.highlight', limit: 200 });
      return logs.find(item => item.log_id === invoked.log.log_id && item.status !== 'running');
    }, `${action} completion`);
    assert.equal(log.status, expectedStatus, `${action}: ${log.stderr ?? log.error ?? ''}`);
    return log;
  }

  async workspace(id) { return (await this.request('workspace.get', { workspace_id: id })).workspace; }
  async panes() { return (await this.request('pane.list')).panes; }

  store() {
    const env = { ...this.env, HERDR_BIN_PATH: binary,
      HERDR_PLUGIN_STATE_DIR: join(this.env.XDG_STATE_HOME, 'herdr-dev', 'plugins', 'aziffo.highlight') };
    const runtime = runtimeFromEnv(env);
    return new HighlightStore(runtime.stateDir, runtime.namespace);
  }
}

test('plugin actions, lifecycle and startup restoration use the correct isolated endpoint', {
  skip: !binary || process.platform === 'win32', timeout: 120000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-highlight-integration-'));
  const sharedState = join(root, 'state');
  const a = new Endpoint(root, 'a', sharedState);
  const b = new Endpoint(root, 'b', sharedState);
  t.after(async () => {
    await Promise.allSettled([a.stop(), b.stop()]);
    rmSync(root, { recursive: true, force: true });
  });
  await a.start();
  await a.link();
  const first = (await a.request('workspace.create', { label: 'Focused workspace', cwd: root, focus: true })).workspace;
  const other = (await a.request('workspace.create', { label: 'Target, not focus', cwd: root, focus: false })).workspace;
  const context = { workspace_id: other.workspace_id, tab_id: other.active_tab_id };
  await a.request('workspace.focus', { workspace_id: first.workspace_id });
  await a.request('workspace.report_metadata', {
    workspace_id: other.workspace_id, source: 'integration.other', tokens: { unrelated: 'keep me' },
  });
  await a.action('workspace-red', context);
  assert.equal((await a.workspace(other.workspace_id)).tokens.highlight_workspace, 'Red');
  assert.equal((await a.workspace(first.workspace_id)).tokens?.highlight_workspace, undefined);
  const targetPanes = (await a.panes()).filter(pane => pane.workspace_id === other.workspace_id);
  assert.ok(targetPanes.length > 0);
  assert.ok(targetPanes.every(pane => pane.tokens.highlight_workspace === 'Red'));

  await a.action('tab-blue', context);
  const highlighted = await a.workspace(other.workspace_id);
  assert.match(highlighted.tokens.highlight_tabs, /:Blue/);
  assert.ok((await a.panes()).filter(pane => pane.tab_id === context.tab_id)
    .every(pane => pane.tokens.highlight_tab === 'Blue'));
  const rejected = await a.action('tab-red', {
    workspace_id: first.workspace_id, tab_id: context.tab_id,
  }, 'failed');
  assert.match(rejected.stderr, /belong|workspace/i);
  assert.match((await a.workspace(other.workspace_id)).tokens.highlight_tabs, /:Blue/);
  await a.action('tab-clear', context);
  assert.equal((await a.workspace(other.workspace_id)).tokens.highlight_tabs, undefined);
  assert.equal((await a.workspace(other.workspace_id)).tokens.highlight_workspace, 'Red');
  assert.ok((await a.panes()).filter(pane => pane.tab_id === context.tab_id)
    .every(pane => pane.tokens?.highlight_tab === undefined));
  await a.action('tab-blue', context);

  await a.action('workspace-clear', context);
  const cleared = await a.workspace(other.workspace_id);
  assert.equal(cleared.tokens.highlight_workspace, undefined);
  assert.equal(cleared.tokens.unrelated, 'keep me');
  assert.match(cleared.tokens.highlight_tabs, /:Blue/);
  await a.request('workspace.report_metadata', {
    workspace_id: other.workspace_id, source: 'aziffo.highlight', seq: 1,
    tokens: { highlight_workspace: 'Red' },
  });
  assert.equal((await a.workspace(other.workspace_id)).tokens.highlight_workspace, undefined,
    'an older in-flight plugin projection cannot resurrect a cleared highlight');
  await a.action('workspace-teal', context);

  await b.start();
  await b.link();
  const bFirst = (await b.request('workspace.create', { label: 'Second endpoint', cwd: root, focus: true })).workspace;
  await b.action('workspace-yellow', { workspace_id: bFirst.workspace_id });
  assert.equal((await b.workspace(bFirst.workspace_id)).tokens.highlight_workspace, 'Yellow');
  assert.equal((await a.workspace(first.workspace_id)).tokens?.highlight_workspace, undefined);
  assert.equal((await a.workspace(other.workspace_id)).tokens.highlight_workspace, 'Teal');

  await a.stop();
  await a.start();
  await eventually(async () => {
    const workspace = await a.workspace(other.workspace_id);
    return workspace.tokens?.highlight_workspace === 'Teal' && workspace.tokens?.highlight_tabs?.includes(':Blue');
  }, 'startup hook restoring saved workspace and tab metadata');
  await eventually(async () => {
    const panes = (await a.panes()).filter(pane => pane.workspace_id === other.workspace_id);
    return panes.length > 0 && panes.every(pane => pane.tokens?.highlight_workspace === 'Teal');
  }, 'startup pane projections');
  assert.equal((await a.workspace(first.workspace_id)).tokens?.highlight_workspace, undefined,
    'restoration must not apply another socket\'s identically numbered workspace');
  assert.equal((await b.workspace(bFirst.workspace_id)).tokens.highlight_workspace, 'Yellow');

  const extra = (await a.request('tab.create', { workspace_id: other.workspace_id, cwd: root, focus: false })).tab;
  await eventually(async () => {
    const panes = (await a.panes()).filter(pane => pane.tab_id === extra.tab_id);
    return panes.length > 0 && panes.every(pane => pane.tokens?.highlight_workspace === 'Teal');
  }, 'new pane projection');
  await a.action('tab-mauve', { workspace_id: other.workspace_id, tab_id: extra.tab_id });
  await a.request('tab.close', { tab_id: extra.tab_id });
  await eventually(() => {
    const store = a.store();
    try { return store.get('tab', extra.tab_id) === null; } finally { store.close(); }
  }, 'tab-close hook pruning persisted tab state');
  await a.request('workspace.close', { workspace_id: other.workspace_id });
  await eventually(() => {
    const store = a.store();
    try { return store.get('workspace', other.workspace_id) === null && store.get('tab', context.tab_id) === null; }
    finally { store.close(); }
  }, 'workspace-close hook pruning only its persisted state');
  const bStore = b.store();
  try { assert.equal(bStore.get('workspace', bFirst.workspace_id), 'yellow'); } finally { bStore.close(); }
});
