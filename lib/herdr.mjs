import { spawnSync } from 'node:child_process';

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
    this.run(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', `${target.kind}-picker`,
      '--env', `HIGHLIGHT_TARGET_CONTEXT_JSON=${JSON.stringify(context)}`]);
  }
}
