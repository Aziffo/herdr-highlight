# Minimal generic Herdr extension points

Audited against official `herdrdev/herdr` master
[`5da0a01e1eedda054db0c81dd3a780000c40d9f0`](https://github.com/herdrdev/herdr/commit/5da0a01e1eedda054db0c81dd3a780000c40d9f0)
(0.9.3). These are proposals, not APIs implemented by this plugin.

## 1. Context-valid plugin actions in native menus

[`src/client/shell/context_menu.rs`](https://github.com/herdrdev/herdr/blob/5da0a01e1eedda054db0c81dd3a780000c40d9f0/src/client/shell/context_menu.rs)
constructs fixed workspace/tab menu items. Plugin action manifests already
declare `contexts`, and `plugin.action.invoke` already accepts a context. There
is no connection between those two features and native right-click menus.
Action contexts are descriptive today; the host does not enforce validity.

The smallest useful change is to append a generic **Plugin actions** section:

- Filter enabled, platform-compatible actions by the clicked resource's kind.
- Construct workspace/tab/pane context consistently from the clicked target,
  including ownership, rather than merging a target with unrelated focused IDs.
- Invoke through the target's owning endpoint, including SSH.
- Preserve native menu keyboard, dismissal and disabled-action behavior.

That immediately makes this plugin's picker reachable by right-click. It does
not require a highlight-specific API, arbitrary code in rendering, or a new
plugin lifecycle. Exact `Highlight ▸` grouping is a separate optional generic
manifest group/submenu field; it is not required for the basic extension point.

## 2. Generic metadata styling on native surfaces

Workspace and pane APIs support custom metadata tokens, and client snapshots
carry those tokens. Tabs have neither `tab.report_metadata` nor a generic token
map. The native tab bar does not consult metadata. Sidebar token styles affect
individual token occurrences, not the surrounding row or its background.

Two small, independent hooks would close this gap:

1. Add **tab metadata parity**: `tab.report_metadata`, optional `TabInfo.tokens`,
   and JSON client-shell tab tokens, using existing workspace/pane metadata
   limits, source ordering and clearing semantics. No highlight-specific field
   or binary pane protocol change is necessary.
2. Add **client-owned appearance rules** for workspace rows and tab entries:
   match generic resource metadata and choose foreground/background/marker
   from existing theme palette tokens. Preserve focus contrast and bold/accent
   indicators. Apply consistently in desktop, agent, compact and mobile views.

For example, a future client rule could match `highlight_workspace = "Teal"`
and resolve its marker to `Palette.teal`; this is illustrative, **not valid
current config**. A plugin should only report neutral values, not RGB strings
or terminal escape sequences. The client owns theme resolution and rendering.

Existing custom token rules accept strict hex foreground values, so extending
that color parser to palette references would improve token visualization
alone. It would still leave native row backgrounds and tab entries unsupported.
Generic inheritance of workspace/tab tokens in Agent rows would also eliminate
this plugin's pane-level display projections.

## Additional v1 limits found during implementation

- **Popup context:** `plugin.pane.open` rebuilds context from active focus.
  It does not preserve an action's supplied context. This plugin uses the
  supported custom `--env` channel to carry its own original target. A generic
  explicit pane invocation-context field would remove that duplication.
- **Session identity:** plugin state is shared across sessions, while public
  resource IDs can be reused by newly created sessions. Injecting a persisted
  session UUID/incarnation into plugin context/runtime would provide a clean
  identity namespace. Socket-path hashing distinguishes simultaneous sessions,
  but cannot distinguish delete/recreate at the same path.
- **Theme access:** v1 exposes no active palette to plugin terminals. Generic
  palette references in client style rules are preferable to asking each
  plugin to parse user configuration and track client-side theme changes.
- **Lifecycle reliability:** hooks are finite asynchronous commands, not a
  durable event queue. Startup reapplication recovers display state; missed
  close hooks can leave orphaned choices. A stable session identity helps
  prevent those records from accidentally addressing unrelated new resources.

No core changes, native resource renaming, private-state access, or metadata
escape-sequence injection are used in this repository.
