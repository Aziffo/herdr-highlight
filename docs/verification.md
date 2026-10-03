# Verification

Tested on 2026-10-03 against an unmodified checkout of official
`herdrdev/herdr` master at
[`5da0a01e1eedda054db0c81dd3a780000c40d9f0`](https://github.com/herdrdev/herdr/commit/5da0a01e1eedda054db0c81dd3a780000c40d9f0),
version 0.9.3. The core checkout stayed clean. Existing user sessions and installed
Herdr executables were not replaced for these tests.

## Automated checks

- `npm run check`: JavaScript syntax and whitespace checks passed.
- `npm test`: 18 tests passed on Linux with Node 26.8.1 locally and Node 24.18.0
  through SSH on a second Linux host.
- `HERDR_TEST_BIN=/path/to/master/herdr npm run test:integration`: passed on both
  hosts using isolated current-master servers, temporary configuration and
  endpoint sockets.
- [GitHub Actions](https://github.com/Aziffo/herdr-highlight/actions/workflows/test.yml)
  runs the portable unit/check suite on Linux, macOS and Windows, using Node 24
  and 26. Native Herdr/TTY integration was not run on macOS or Windows.
- Installing `Aziffo/herdr-highlight` from GitHub using current master's
  `herdr plugin install ... --yes` succeeded in an isolated configuration,
  registering all 21 actions and the startup hook with no manifest warnings.

Unit tests were introduced before the corresponding core/picker modules and
observed failing, then made green. The concurrency regression exercises an
older projection paused during a pane move while a newer projection finishes.
Separate Node processes verify SQLite record preservation and monotonic counters.
Repeated CI exposed an immediate `SQLITE_BUSY` race while simultaneous first
connections switched a fresh database to WAL. Initialization now retries that
specific condition and creates the schema transactionally. Twenty local fresh-
database concurrency runs passed; an additional temporary-reader test verifies
initialization can wait for the WAL transition to become available.

The real-server integration test verifies:

1. Explicit nonfocused workspace/tab action contexts.
2. Rejection of inconsistent tab/workspace context without altering saved state.
3. Independent tab/workspace clearing, preserving another plugin's tokens.
4. Metadata sequence guards against an older set resurrecting a cleared choice.
5. Shared plugin storage isolated by endpoint socket.
6. Startup recovery after an actual server stop/start and session restore.
7. Projection onto newly created panes and cleanup on workspace/tab close.

The remote filesystem showed unusually slow journal commits during validation:
the disk-backed unit run passed but took about 159 seconds, and a simultaneous
action hit SQLite's five-second lock timeout. The final 17-test and integration
runs used a memory-backed temporary test directory on that host and passed.
These runs prove Node 24 and endpoint behavior, not resilience to that disk stall
or power-loss durability. Production state is normally disk-backed under the
host-provided state directory. A lock failure is reported in the plugin log;
retry the failed action once storage is responsive. If a choice was already
saved but metadata reporting failed, use the restore action.

## Live popup

A real current-master TUI was attached to an isolated local server through a PTY.
The host's first-run welcome screen was dismissed before opening plugin popups.
Verified:

- The workspace picker retained an explicitly supplied, nonfocused target.
- Pressing `5` applied Teal to that workspace, leaving the focused one unchanged.
- Six down-arrow presses and Enter applied Blue to the supplied tab.
- Escape left its existing choice unchanged.
- A real SGR mouse click on Red applied Red and closed the popup.

Fake-TTY unit tests separately verify raw-mode restoration, mouse reporting and
cursor cleanup, listener removal, cancellation, split escape sequences and
small-window rendering. Real macOS/Windows terminal interaction remains unverified.

## Review and operational limits

Simplification removed unused/repeated work and grouped tab summaries by workspace.
Independent correctness, security, testing, maintainability, agent-accessibility,
performance, reliability and adversarial reviews completed. The one confirmed
metadata ordering race was fixed and independently validated; no actionable
findings remained.

Metadata projection currently performs one CLI report per live workspace/pane.
Large lifecycle bursts and total projection time across hundreds of panes have
not been benchmarked. Each CLI call has a ten-second timeout; SQLite lock waits
are bounded to five seconds. Failures retain already committed state and are
visible through Herdr's normal plugin logs.

Native menu entries, full row/tab-bar coloring, active-theme palette access and
session-incarnation identity are documented [extension gaps](extension-gaps.md),
not behaviors claimed by this plugin.
