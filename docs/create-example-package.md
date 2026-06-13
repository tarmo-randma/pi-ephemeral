# Create an example pi-ephemeral package

This guide is for an agent running inside Pi.

Create a local example package at:

```text
~/.pi/packages/pi-ephemeral-example-resources
```

If that directory already exists, stop. Tell the user that the example package already exists and that they should edit it directly, remove or rename it, explicitly ask to overwrite it, or abort. Do not create a second package with a timestamped or alternate name.

Do not copy, move, remove, or modify existing resources under `~/.pi/agent` or any project `.pi` directory.

## Files to create

Create this structure:

```text
~/.pi/packages/pi-ephemeral-example-resources/
├── package.json
├── README.md
└── ephemeral/
    ├── resources.json
    └── skills/
        └── ephemeral-example/
            └── SKILL.md
```

Use the file contents from `examples/minimal-skill-package/` in the `@tarmo-randma/pi-ephemeral` repository.

After creating the files, run `npm install` in the package directory so the `@tarmo-randma/pi-ephemeral` dependency is installed.

## Handoff to the user

After creating the package, explain:

- the package path
- that only `pi-ephemeral` is always loaded
- that `skill ephemeral-example` is optional until enabled
- that no existing Pi resources were modified
- how to add more resources later by copying files into `ephemeral/` and adding entries to `ephemeral/resources.json`

Then ask whether the user wants to install this local package into Pi now.

If the user approves, install the package globally/user-scope with Pi's package install command for the package path. After installation, tell the user:

1. Run `/reload`.
2. Open `/pi-ephemeral`.
3. Enable `skill ephemeral-example` in the TUI.
4. Run `/reload` again.
5. Ask the agent to use the `ephemeral-example` skill.

For command-mode fallback inside Pi, use `/pi-ephemeral list` and `/pi-ephemeral enable skill ephemeral-example`.

## Editing later

If this local package is already installed, do not reinstall the same path as a way to apply edits. Edit the package files directly.

After editing package resources or catalogs, run `/reload` or restart Pi so package metadata is read again. If already-enabled resources need symlinks refreshed, run `/pi-ephemeral repair --all`.
