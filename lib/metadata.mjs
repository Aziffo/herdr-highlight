import { colorLabel } from './colors.mjs';

function boundedSummary(parts) {
  let text = '';
  for (let index = 0; index < parts.length; index++) {
    const candidate = [text, parts[index]].filter(Boolean).join(' ');
    if (candidate.length > 65) return `${text} +${parts.length - index} more`;
    text = candidate;
  }
  return text || null;
}

export function planMetadata(snapshot, rows) {
  const colors = new Map(rows.map(row => [`${row.kind}:${row.resource_id}`, row]));
  const color = (kind, id, workspaceId) => {
    const row = colors.get(`${kind}:${id}`);
    return row && row.workspace_id === workspaceId ? colorLabel(row.color) : null;
  };
  const patches = [];
  const tabsByWorkspace = new Map();
  for (const tab of snapshot.tabs) {
    if (!tabsByWorkspace.has(tab.workspace_id)) tabsByWorkspace.set(tab.workspace_id, []);
    tabsByWorkspace.get(tab.workspace_id).push(tab);
  }
  function add(kind, resource, tokens) {
    // Even unchanged values advance the sequence barrier. Otherwise a clear
    // could skip a resource while an older set is still waiting to report.
    patches.push({ kind, id: resource[`${kind}_id`], tokens });
  }
  for (const workspace of snapshot.workspaces) {
    const id = workspace.workspace_id;
    const parts = (tabsByWorkspace.get(id) ?? [])
      .sort((a, b) => a.number - b.number)
      .flatMap(tab => {
        const label = color('tab', tab.tab_id, id);
        return label ? [`t${tab.number}:${label}`] : [];
      });
    add('workspace', workspace, {
      highlight_workspace: color('workspace', id, id),
      highlight_tabs: boundedSummary(parts),
    });
  }
  // These are display projections of workspace/tab state, not pane highlights.
  for (const pane of snapshot.panes) {
    add('pane', pane, {
      highlight_workspace: color('workspace', pane.workspace_id, pane.workspace_id),
      highlight_tab: color('tab', pane.tab_id, pane.workspace_id),
    });
  }
  return patches;
}

export function reapply(client, store) {
  const { seq, rows } = store.snapshot();
  // Allocate ordering before reading live topology. A delayed old topology
  // must not acquire a newer sequence than the hook which observed a move.
  const snapshot = client.snapshot();
  const errors = [];
  for (const patch of planMetadata(snapshot, rows)) {
    try { client.report(patch, seq); }
    catch (error) {
      // A resource can close between the list and report calls.
      if (!['pane_not_found', 'workspace_not_found'].includes(error.code)) errors.push(error.message);
    }
  }
  if (errors.length) throw new Error(`Saved state retained; display projection failed: ${errors.join('; ')}. Run the restore action to retry.`);
  return { seq, rows };
}
