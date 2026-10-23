# pi-ephemeral Current Functionality Reference

`pi-ephemeral` manages optional Pi resources from a host package catalog. It exposes both a Node CLI (`pi-ephemeral`) and a Pi extension command (`/pi-ephemeral`) backed by the same catalog, state, planning, and symlink-application core.

## Resource model

Supported resource types are singular:

- `extension`
- `skill`
- `prompt`
- `theme`

A host package may provide two catalogs:

- `resources.json` for always-on resources exposed by the host package itself.
- `ephemeral/resources.json` for optional resources that can be enabled or disabled.

Catalog records use:

```json
{
  "type": "skill",
  "name": "librarian",
  "path": "ephemeral/skills/librarian",
  "description": "Evidence-backed open-source library research",
  "bundle": "pi-web-access",
  "infra": {}
}
```

Required fields are `type`, `name`, and `path`. `description`, `bundle`, and `infra` are optional. Catalogs must not define a `target` field; target paths are derived from resource type and source path.

An `extension` source may be a `.ts`/`.js` file, an index-based directory, or a native package directory whose `package.json#pi.extensions` has at least one declared entry that exists. Missing or unusable sibling declarations do not reject an otherwise usable package. Activation always links the complete source directory at the normal derived extension target; it does not create links for individual manifest entries or contained resources.

## Activation scopes

Resources can be active through three scopes:

1. **Always-on**: resources listed in `resources.json` and loaded by the host package. They are visible but read-only to `pi-ephemeral`.
2. **Global**: optional resources activated for the current Pi agent directory, usually `~/.pi/agent`.
3. **Project**: optional resources activated in a resolved project `.pi/` directory.

Global and project activations are stored as JSON state files and materialized as symlinks into Pi discovery directories. Existing sessions see changed resources at Pi reload/startup boundaries. Successful `/pi-ephemeral enable` and `/pi-ephemeral disable` commands automatically reload the current session.

## Bundles

Catalog records may set `bundle` to group related resources. Bundles are synthetic UI/action groups, not activation records and not filesystem targets.

Bundle behavior:

- Root/default views show bundle rows and unbundled resources.
- Detail views show bundle child resources.
- Bundle enable/disable actions cascade to editable children.
- Detail mode allows individual child toggles.
- A one-extension bundle backed by a native package directory remains atomic: only its bundle and extension rows are actionable. Statically discoverable contained skills, prompts, and themes belong to that package extension; they are informational rows, not synthetic children or activation records.
- Partial bundle state uses `*`, for example `global*` or `project*`.
- Bundle rows warn when child activations mix global and project scopes.

## CLI commands

### `menu`

```bash
pi-ephemeral menu [--global|--project] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

Opens the existing manager in an ordinary interactive terminal. Scope starts as project by default;
use `--global` to start with host-wide choices. The header shows scope and its resolved target. `g` switches
between project and global without writing anything, but only with no pending choices: save or undo them
first. Space stages a toggle (toggle back to undo), Enter saves, and Escape/Ctrl+C cancels. It uses the same
catalogue, bundles, search and sequential writer as the Pi menu, not a second activation backend. Write errors remain visible and can represent partial saves.
Closing after a failed save returns failure (`1`), not ordinary cancellation, and preserves the partial-save
warning. A successful retry completes normally and allows the intended conversation to reload.

Exit statuses: `0` successful save with changes, `3` no changes, `130` cancelled, `1` failure. The standalone
menu does not send anything to a conversation. With the extension loaded, each affected conversation
refreshes saved choices before its next ordinary idle input, including partial choices left by a failed
save. JSON commands remain non-interactive; `menu` does not accept `--json`.

### `list`

```bash
pi-ephemeral list [--filter <query>] [--all] [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

Shows available resources grouped by bundle. Human output is a table with `Use`, `Type`, and `Name`. It is for discovery only and does not show descriptions, targets, or action columns.

`--filter <query>` searches the same fields used by TUI search: type, name, identity, description, and bundle name where applicable. Resource/child matches show the necessary parent bundle plus matching children only. Bundle-name matches show the bundle plus all children. JSON output remains a flat list of resource projections and includes `filter` when used.

### `status`

```bash
pi-ephemeral status [--all] [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

Shows active resources only. Human output is bundle-grouped and includes target paths because status describes actual activations/symlinks. JSON output preserves the activation-state shape for global and project activations.

### `info`

```bash
pi-ephemeral info <type> <name> [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
pi-ephemeral info <query> [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

The exact form returns one resource and preserves exact JSON shape with a top-level `resource` property.

The query form searches all resources. Human output renders one aligned detail block per matching resource. Child resource blocks include `Bundle`. Query JSON uses a top-level `resources` array. If a query matches a bundle but no child resource directly matches, a compact bundle block may be shown only for a sole direct bundle match; child matches do not duplicate a separate bundle section.

### `enable` and `disable`

```bash
pi-ephemeral enable <type> <name> [--global|--project] [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
pi-ephemeral disable <type> <name> [--global|--project] [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

Enables or disables one optional resource in the selected scope. Default scope is project. Global activation can prune redundant project activation when a resource is promoted globally.

### `repair`

```bash
pi-ephemeral repair [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

Repairs active resources everywhere relevant: global activations, indexed projects, and the current project when it has `.pi/pi-ephemeral.json` with activations. It updates symlinks for activations found in the catalog. When the optional catalog was successfully read and is valid, repair removes global and project activation entries and their managed symlinks for identities no longer catalogued. If the optional catalog is missing, unreadable, malformed, or invalid, repair conservatively retains missing identities and reports them as skipped. Repair also prunes stale or empty project index entries, and does not enable inactive resources or upgrade packages.

### Global config package root

The standalone CLI reads `packageRoot` from `~/.pi/agent/pi-ephemeral-global.json` when `--package` is not supplied. The file is a combined global config/state document. Global state writes preserve config fields such as `packageRoot`. Relative paths are resolved relative to the path used to open the global config file, normally `~/.pi/agent/`, not the symlink target realpath.

### Common CLI flags

- `--package <dir>`: explicit package/catalog root; overrides `packageRoot` from global pi-ephemeral config.
- `--agent-dir <dir>`: Pi agent config directory. Defaults to `~/.pi/agent` or `PI_CODING_AGENT_DIR` where applicable.
- `--cwd <dir>`: project context for project state resolution. Defaults to current directory.
- `--json`: machine-readable output for scripts. Exact command JSON shapes are kept stable.
- `-w, --width <columns>`: human table width. Default is `100`; terminal width is not auto-detected.

`--filter` is accepted only by `list`.

## Pi extension and TUI

The Pi extension exposes `/pi-ephemeral` commands. Command mode mirrors CLI behavior where applicable. Desktop TUI opens from `/pi-ephemeral` and provides an interactive resource manager.

Successful `/pi-ephemeral enable` and `/pi-ephemeral disable` slash commands automatically reload current-session resources, including in native T3 Pi sessions; no restart or second command is needed. They wait for the current turn to become idle before changing activation state, then save activation, notify, and reload. A reload failure is reported as an error explicitly stating that activation was saved on disk; it does not roll back activation or claim the session was reloaded. Failed activation commands do not reload. The interactive Pi menu uses this same reload flow after a successful save with changes; cancel and unchanged saves do not reload. `/pi-ephemeral reload` waits until idle and refreshes saved activations without another mutation or a model call; it is an extension command, not the TUI-only `/reload`. Read-only commands, `repair`, and standalone CLI commands do not reload a conversation.

TUI behavior:

- Shows a bundle-aware resource table with a single-line scope/target header and row counter in the help footer.
- Standalone menus use the available terminal height and recalculate their list viewport on resize.
- `g` switches project/global scope when nothing is staged; in search-entry mode it remains ordinary text.
- Default mode shows root rows only.
- Detail mode (`d`) reveals child resources.
- Detail mode shows statically discoverable resources contained by an atomic native package as muted in-table rows beneath the package bundle. Their `Use` and `Action` cells are blank and the rows are read-only; toggling remains on the owning package bundle or extension.
- Search (`/`) filters resources using the shared resource-search model and reveals matching bundled or contained rows beneath the necessary parent bundle even when detail mode is off. A package bundle filtered by a contained-row match still toggles its atomic extension.
- Backspace-to-empty exits search mode so navigation resumes.
- Real keyboard handling supports `j/k`, arrow keys, printable Kitty CSI-u input, and Esc close/cancel.
- TUI table alignment keeps title/status/header/content columns semantically aligned while accounting for the SelectList selector gutter; child indentation appears only inside the `Type` cell.

### Changes saved outside a conversation

This next-input workflow requires Pi 1.3 or newer public command-expansion APIs. Before a new ordinary
idle user input, the extension compares normalized global/project activation choices
with its discovery-boundary snapshot. Changed choices trigger the existing reload command, then replay the
original text/images through the fresh runtime; the original input dispatch is handled exactly once.
Busy steering is unchanged; changes are checked at the next new idle input. Registered extension commands
already dispatch before input, while a newly enabled slash command can be discovered and replayed after
refresh. Unchanged choices do not repeatedly reload. There is no watcher, transport, daemon or second backend.

The hook must load before source-transforming input extensions such as T3's skill-chip bridge. In T3's
native Pi launch arguments, prepend `--extension "/absolute/path/to/host-package"`, keeping the existing
arguments and package configuration. The host package directory preserves catalogue metadata; a standalone
path to this extension's dist file does not. The same host entry is deduplicated at startup and reload.
Configured arguments precede T3's bridge; no T3 application patch/restart is required. New processes need
this one-time bootstrap; editing files does not retrofit the ordering of resident Pi runtimes.

If no model or synchronously configured authentication is available, input is left to Pi's native preflight.
Async-only auth providers can use `/pi-ephemeral reload`. Replay input has source `extension` rather than
its original `rpc`/`interactive`; source-sensitive extensions can observe that difference. Ordinary replay
starts agent activity before the original RPC responds handled; a newly registered extension slash command
does not require agent activity. Saved choices are recorded when refresh is attempted to avoid retry loops.

A late Pi reload failure can leave the old runtime invalidated, as with manual reload. The completion gate
rejects, reports that activation was saved but reload failed, and lets Pi settle the original input using
its normal error handling. This exceptional already-broken session can produce stale-handler diagnostics;
restart **that Pi conversation**. No rollback, timeout, synthetic lifecycle or process restart is performed.

## Host package integration

A host Pi package provides catalogs and loads the `pi-ephemeral` extension. Optional resources usually live under `ephemeral/` and are activated by symlink through `pi-ephemeral` state. Existing sessions see changed resources at Pi reload/startup boundaries. Successful `/pi-ephemeral enable` and `/pi-ephemeral disable` commands automatically reload the current session.

## Validation expectations

Changes to resource behavior should be covered by Vitest tests for core planner/search/display logic, CLI parsing/output, extension command routing, and TUI behavior. TUI rendering or keyboard changes require hands-off real Kitty smoke validation rather than relying on manual user testing.
