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

## Activation scopes

Resources can be active through three scopes:

1. **Always-on**: resources listed in `resources.json` and loaded by the host package. They are visible but read-only to `pi-ephemeral`.
2. **Global**: optional resources activated for the current Pi agent directory, usually `~/.pi/agent`.
3. **Project**: optional resources activated in a resolved project `.pi/` directory.

Global and project activations are stored as JSON state files and materialized as symlinks into Pi discovery directories. Existing sessions need Pi reload/startup boundaries to see changed resources.

## Bundles

Catalog records may set `bundle` to group related resources. Bundles are synthetic UI/action groups, not activation records and not filesystem targets.

Bundle behavior:

- Root/default views show bundle rows and unbundled resources.
- Detail views show bundle child resources.
- Bundle enable/disable actions cascade to editable children.
- Detail mode allows individual child toggles.
- Partial bundle state uses `*`, for example `global*` or `project*`.
- Bundle rows warn when child activations mix global and project scopes.

## CLI commands

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
pi-ephemeral repair [<type> <name>] [--global|--project|--all] [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
```

Repairs active resources after package or catalog changes. It refreshes symlinks/state, removes missing activations, and prunes stale project index entries when `--all` is used. `repair` does not enable inactive resources and is not a package upgrade command.

### Common CLI flags

- `--package <dir>`: package/catalog root. Usually inferred; useful for tests and manual package selection.
- `--agent-dir <dir>`: Pi agent config directory. Defaults to `~/.pi/agent` or `PI_CODING_AGENT_DIR` where applicable.
- `--cwd <dir>`: project context for project state resolution. Defaults to current directory.
- `--json`: machine-readable output for scripts. Exact command JSON shapes are kept stable.
- `-w, --width <columns>`: human table width. Default is `100`; terminal width is not auto-detected.

`--filter` is accepted only by `list`.

## Pi extension and TUI

The Pi extension exposes `/pi-ephemeral` commands. Command mode mirrors CLI behavior where applicable. Desktop TUI opens from `/pi-ephemeral` and provides an interactive resource manager.

TUI behavior:

- Shows a bundle-aware resource table.
- Default mode shows root rows only.
- Detail mode (`d`) reveals child resources.
- Search (`/`) filters resources using the shared resource-search model and reveals matching bundled children even when detail mode is off.
- Backspace-to-empty exits search mode so navigation resumes.
- Real keyboard handling supports `j/k`, arrow keys, printable Kitty CSI-u input, and Esc close/cancel.
- TUI table alignment keeps title/status/header/content columns semantically aligned while accounting for the SelectList selector gutter; child indentation appears only inside the `Type` cell.

## Host package integration

A host Pi package provides catalogs and loads the `pi-ephemeral` extension. Optional resources usually live under `ephemeral/` and are activated by symlink through `pi-ephemeral` state. Existing sessions need Pi reload/startup boundaries to see changed resources.

## Validation expectations

Changes to resource behavior should be covered by Vitest tests for core planner/search/display logic, CLI parsing/output, extension command routing, and TUI behavior. TUI rendering or keyboard changes require hands-off real Kitty smoke validation rather than relying on manual user testing.
