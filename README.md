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

The example package contains one optional skill, `ephemeral-example`, so you can see the flow before adapting the package for your own resources.

## How it works

A Pi package can load `pi-ephemeral` as its always-on extension and list optional resources in `ephemeral/resources.json`. Those resources are not loaded until you enable them with `/pi-ephemeral`.

Typical flow:

1. Create or adapt a local Pi package.
2. Install that package into Pi.
3. Run `/reload`.
4. Open `/pi-ephemeral`.
5. Enable optional resources when needed.
6. Run `/reload` again so active sessions discover newly enabled resources.

## Example package

See `examples/minimal-skill-package/` for a minimal package with one optional skill.

## Reference

See `docs/current-functionality.md` for the current catalog shape, commands, bundle behavior, and validation expectations.
