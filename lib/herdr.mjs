import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

export const PLUGIN_ID = 'aziffo.highlight';

export class HerdrClient {
  constructor(env) { this.env = env; }

  run(args) {
    const result = spawnSync(this.env.HERDR_BIN_PATH, args, {
      env: this.env, encoding: 'utf8', shell: false, timeout: 10000,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}, signal ${result.signal}`;
      const error = new Error(`Herdr ${args.slice(0, 2).join(' ')} failed: ${detail}`);
      for (const line of (result.stderr ?? '').split('\n').reverse()) {
        try { error.code = JSON.parse(line).error?.code; if (error.code) break; } catch { /* Plain CLI diagnostic. */ }
      }
      throw error;
    }
    if (!result.stdout.trim()) return {};
    const response = JSON.parse(result.stdout);
    if (response.error) {
      const error = new Error(response.error.message);
      error.code = response.error.code;
      throw error;
    }
    return response.result ?? response;
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.env.HERDR_SOCKET_PATH);
      let text = '';
      socket.setTimeout(10000, () => socket.destroy(new Error(`Herdr ${method} timed out`)));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'highlight', method, params })}\n`));
      socket.on('data', chunk => {
        text += chunk.toString();
        if (!text.includes('\n')) return;
        socket.destroy();
        try {
          const response = JSON.parse(text.split('\n')[0]);
          if (response.error) reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
          else resolve(response.result);
        } catch (error) { reject(error); }
      });
      socket.on('end', () => { if (!text.includes('\n')) reject(new Error('Herdr closed without a response')); });
    });
  }

  async nativePaneHighlight(target, color) {
    try {
      await this.request('pane.highlight', { pane_id: target.id, color });
      return true;
    } catch (error) {
      // Official Herdr has no native highlight API; retain the portable plugin path.
      if (['unknown_method', 'method_not_found'].includes(error.code)
        || (error.code === 'invalid_request' && /unknown variant|unknown method/i.test(error.message))) return false;
      throw error;
    }
  }

  get(kind, id) { return this.run([kind, 'get', id])[kind]; }

  snapshot() {
    return {
      workspaces: this.run(['workspace', 'list']).workspaces,
      tabs: this.run(['tab', 'list']).tabs,
      panes: this.run(['pane', 'list']).panes,
    };
  }

  report(patch, seq) {
    const args = [patch.kind, 'report-metadata', patch.id, '--source', PLUGIN_ID, '--seq', String(seq)];
    for (const [key, value] of Object.entries(patch.tokens)) {
      args.push(...(value === null ? ['--clear-token', key] : ['--token', `${key}=${value}`]));
    }
    this.run(args);
  }

  openPicker(target) {
    const context = { workspace_id: target.workspaceId };
    if (target.kind === 'tab') context.tab_id = target.id;
    if (target.kind === 'pane') context.focused_pane_id = target.id;
    this.run(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', `${target.kind}-picker`,
      '--env', `HIGHLIGHT_TARGET_CONTEXT_JSON=${JSON.stringify(context)}`]);
  }
}
