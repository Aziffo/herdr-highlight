# herdr-highlight

A plugin implementation of the persistent workspace/tab color choices in
[Aziffo/herdr#1](https://github.com/Aziffo/herdr/pull/1), using existing Herdr plugin v1 APIs.
No Herdr core patches are required.

Choose **None, Red, Peach, Yellow, Green, Teal, Blue, Mauve or Gray** in a popup,
or invoke a direct action. Choices are stored in the plugin's own state directory
and reapplied as sidebar metadata at server startup.

| Capability | Plugin v1 implementation |
| --- | --- |
| Workspace/tab set and clear | Context-targeted plugin actions |
| Color picker | Transient popup; arrows, Enter, 0–8, mouse; Esc/Ctrl+C cancel |
| Persistence and startup recovery | SQLite under `HERDR_PLUGIN_STATE_DIR`; startup hook |
| Workspace visualization | Custom Space sidebar tokens |
| Tab visualization | Workspace tab summary and Agent sidebar token |
| Native right-click `Highlight ▸` | **Unavailable:** native menus do not expose plugin actions |
| Native workspace row / tab-bar coloring | **Unavailable:** generic metadata cannot style those surfaces |
| Theme palette matching | **Unavailable:** plugin v1 does not expose `Palette` tokens |

The plugin does not rename resources, inject escape sequences into metadata, or
modify Herdr configuration. See [extension gaps](docs/extension-gaps.md) for the
small generic upstream hooks that would enable native parity.

## Install

Requirements: **Herdr 0.9.3 or later** with plugin v1, and **Node.js 24 or later**
on the server's `PATH`. There are no npm dependencies or build steps.
The implementation uses [Node's built-in SQLite API](https://nodejs.org/api/sqlite.html).

```sh
herdr plugin install Aziffo/herdr-highlight --yes
herdr plugin action list --plugin aziffo.highlight
```

For development, clone this repository and use `herdr plugin link /path/to/herdr-highlight`.
On SSH endpoints, install/link the plugin and Node **on each remote server**:

```sh
ssh my-server 'herdr plugin install Aziffo/herdr-highlight --yes'
herdr --machine my-server plugin action invoke aziffo.highlight.workspace-red
```

Machine labels are the names configured in Herdr; SSH aliases belong to SSH.
You can also run the ordinary
commands in an SSH shell on that host. The plugin always calls the injected
`HERDR_BIN_PATH` with the injected `HERDR_SOCKET_PATH`, so it operates on its
owning endpoint rather than accidentally calling the client's local session.
State is stored locally on that endpoint; it is not synchronized between hosts.

## Use

Inside Herdr, invoke the picker via a keybinding:

```toml
[[keys.command]]
key = "prefix+h"
type = "plugin_action"
command = "aziffo.highlight.workspace-picker"
description = "Highlight workspace"

[[keys.command]]
key = "prefix+H"
type = "plugin_action"
command = "aziffo.highlight.tab-picker"
description = "Highlight tab"
```

Use ↑/↓ and Enter, click a color, or press 0–8. The saved choice has a check mark.
Esc/Ctrl+C cancel; a choice closes the popup. Popup swatches use terminal ANSI
colors as approximations, not the inaccessible Herdr theme palette.

Direct actions work from the CLI too:

```sh
herdr plugin action invoke aziffo.highlight.workspace-teal
herdr plugin action invoke aziffo.highlight.tab-blue
herdr plugin action invoke aziffo.highlight.workspace-clear
herdr plugin action invoke aziffo.highlight.tab-clear
herdr plugin action invoke aziffo.highlight.restore
```

Each kind has `<kind>-picker`, `<kind>-red`, `-peach`, `-yellow`, `-green`,
`-teal`, `-blue`, `-mauve`, `-gray`, and `-clear`.
Clearing a workspace does not clear its tab choices, and vice versa.

CLI invocation receives the active target. API callers can pass a different
target using `plugin.action.invoke`:

```json
{
  "id": "highlight-example",
  "method": "plugin.action.invoke",
  "params": {
    "plugin_id": "aziffo.highlight",
    "action_id": "tab-blue",
    "context": { "workspace_id": "w2", "tab_id": "w2:t3" }
  }
}
```

The supplied resource must exist. A tab must belong to the supplied workspace;
the plugin never substitutes current focus for an invalid target. Pickers carry
the original target into the popup and revalidate it before saving.

## Show choices in the sidebar

Add these custom tokens to your existing **client** configuration. Merge the
rows with your current layout rather than declaring the same TOML table twice.

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace", "$highlight_workspace"],
  ["branch", "git_status", "$highlight_tabs"],
]

[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "$highlight_workspace", "$highlight_tab"],
]
```

Then reload using `herdr server reload-config` (on the relevant endpoint).
Rows show names such as `Teal`, and summaries such as `t1:Blue t3:Gray`.
Long summaries are bounded to Herdr's 80-character metadata limit.
Unselected tokens disappear. Workspace metadata is projected onto each pane
only for Agent-row display: there is no independently persisted pane highlight.
Agent-specific `rows_by_agent` overrides must include these tokens too.
Custom layouts currently affect expanded desktop sidebars, not compact/mobile layouts.

For colored **token text**, existing conditional sidebar rules can use fixed
RGB values. [examples/sidebar.toml](examples/sidebar.toml) provides all eight
colors for both sidebar modes. These example values are Catppuccin Mocha colors;
adapt them to your theme. Rules cannot reference Herdr palette names or color
the surrounding workspace row/tab-bar entry.

## Persistence and lifecycle

`HERDR_PLUGIN_STATE_DIR/highlights.sqlite` contains only workspace/tab choices,
their owning workspace IDs, a hash of the endpoint socket/pipe path, and
monotonic projection counters. SQLite transactions coordinate simultaneous
actions; metadata sequence numbers prevent older projections overwriting newer ones.
Other plugins' tokens and native labels are untouched. The three `highlight_*`
token names below are reserved to this plugin.

| Surface | Owned tokens |
| --- | --- |
| Workspace metadata | `highlight_workspace`, `highlight_tabs` |
| Pane metadata (display projection) | `highlight_workspace`, `highlight_tab` |

The startup hook runs after session restore, including live handoff. Linking or
enabling a plugin in an already running server does not execute startup hooks;
invoke `aziffo.highlight.restore` to reapply existing choices immediately.
Close hooks delete state, and pane creation/movement hooks refresh projections.
Metadata itself is transient; SQLite remains the source of truth.

If reporting fails after a selection is saved, the saved choice remains intact.
Inspect `herdr plugin log list --plugin aziffo.highlight`, fix the endpoint, then
invoke the restore action. Do not delete the SQLite file as a troubleshooting step.

**Identity limit:** v1 has no stable session-incarnation identifier. An ordinary
restart restores the same socket and public IDs; a deleted/recreated session at
the same socket can reuse those IDs and inherit old choices if close hooks did
not run. A different socket has independent choices. Moving a session's socket
does not migrate its state. This is documented rather than guessed from labels
or filesystem timestamps.

## Development

```sh
npm run check
npm test
HERDR_TEST_BIN=/path/to/current-master/herdr npm run test:integration
```

Integration tests use fresh temporary config, state, session and socket roots;
they never connect to existing sessions. See [verification](docs/verification.md)
for the tested Herdr revision and platform coverage.
