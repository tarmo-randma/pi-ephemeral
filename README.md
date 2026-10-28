# pi-ephemeral

Make Pi extensions, skills, prompts, and themes optional instead of always loaded.

`pi-ephemeral` is for Pi users who want a lighter default setup and want to enable resources only when they are useful globally or in a project.

## Quick start

Paste this into Pi:

```text
Create a local example Pi package that uses @tarmo-randma/pi-ephemeral.

Follow this guide:
https://github.com/tarmo-randma/pi-ephemeral/blob/main/docs/create-example-package.md

Create only the example package from the guide. Do not copy, move, remove, or modify any of my existing Pi resources. After creating the package, explain what was created and ask me before installing it.
```

If your terminal submits multi-line prompts early, use this single-line prompt instead:

```text
Create a local example Pi package at ~/.pi/packages/pi-ephemeral-example-resources that uses @tarmo-randma/pi-ephemeral by following https://github.com/tarmo-randma/pi-ephemeral/blob/main/docs/create-example-package.md; create only that package, do not copy, move, remove, or modify any existing Pi resources, run npm install inside the package, explain what was created, and ask me before installing it into Pi.
```

The example package contains one optional skill, `ephemeral-example`, so you can see the flow before adapting the package for your own resources.

## How it works

A Pi package can load `pi-ephemeral` as its always-on extension and list optional resources in `ephemeral/resources.json`. Those resources are not loaded until you enable them with `/pi-ephemeral`.

Reload and next-input replay use the imported `@tarmo-randma/t3-pi-refresh` library, installed as a normal dependency—not another loaded Pi extension. `pi-ephemeral` works on its own; it does not require `t3-topics` or an MCP configuration reader.

Typical flow:

1. Create or adapt a local Pi package.
2. Install that package into Pi.
3. Run `/reload`.
4. Open `/pi-ephemeral`.
5. Enable optional resources when needed. `/pi-ephemeral enable <type> <name>` and `/pi-ephemeral disable <type> <name>` automatically reload the current session, including in native T3 Pi; no restart or second command is needed.
6. The in-Pi manager also reloads after a successful save. In an ordinary terminal, run `pi-ephemeral menu` (or `menu --global`). Each affected Pi conversation refreshes changed saved choices before its next ordinary idle message; busy steering is left alone. T3 needs the extension loaded before its input bridge through existing Pi launch arguments, not an application patch. See [setup and limits](docs/current-functionality.md#changes-saved-outside-a-conversation).

## Example package

See `examples/minimal-skill-package/` for a minimal package with one optional skill.

## Reference

See `docs/current-functionality.md` for the current catalog shape, commands, bundle behavior, and validation expectations.
