import { createHash } from 'node:crypto';

export function runtimeFromEnv(env, platform = process.platform) {
  for (const name of ['HERDR_BIN_PATH', 'HERDR_SOCKET_PATH', 'HERDR_PLUGIN_STATE_DIR']) {
    if (typeof env[name] !== 'string' || !env[name]) throw new Error(`Missing ${name}; run this through Herdr's plugin host`);
  }
  const socket = platform === 'win32' ? env.HERDR_SOCKET_PATH.replaceAll('/', '\\').toLowerCase() : env.HERDR_SOCKET_PATH;
  return {
    stateDir: env.HERDR_PLUGIN_STATE_DIR,
    namespace: createHash('sha256').update(socket).digest('hex'),
  };
}

export function readContext(env, picker = false) {
  const raw = picker && env.HIGHLIGHT_TARGET_CONTEXT_JSON
    ? env.HIGHLIGHT_TARGET_CONTEXT_JSON : env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) throw new Error('Missing HERDR_PLUGIN_CONTEXT_JSON');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin context');
  return value;
}

export function targetFromContext(kind, context, client) {
  if (!['workspace', 'tab'].includes(kind)) throw new Error('Target must be workspace or tab');
  const id = context[`${kind}_id`];
  if (typeof id !== 'string' || !id) throw new Error(`Context has no ${kind}_id`);
  const resource = client.get(kind, id);
  const workspaceId = resource.workspace_id;
  if (kind === 'tab' && context.workspace_id && context.workspace_id !== workspaceId) {
    throw new Error('Tab context does not belong to the supplied workspace');
  }
  return { kind, id: resource[`${kind}_id`], workspaceId, label: resource.label };
}
