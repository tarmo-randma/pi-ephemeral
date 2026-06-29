import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs } from "../../src/cli/args.js";

describe("CLI argument parser", () => {
  it("parses enable with explicit scope and json", () => {
    expect(parseArgs(["enable", "skill", "brainstorming", "--global", "--json", "--package", process.cwd()])).toMatchObject({
      command: "enable",
      type: "skill",
      name: "brainstorming",
      scope: "global",
      json: true,
      packageRoot: process.cwd(),
    });
  });

  it("parses list/status/info width and repair command surfaces", () => {
    const packageRoot = process.cwd();
    expect(parseArgs(["list", "--all", "--json", "--package", packageRoot])).toMatchObject({ command: "list", all: true, json: true, width: 100 });
    expect(parseArgs(["list", "--filter", "librarian", "--package", packageRoot])).toMatchObject({ command: "list", filter: "librarian" });
    expect(parseArgs(["list", "--width", "80", "--package", packageRoot])).toMatchObject({ command: "list", width: 80 });
    expect(parseArgs(["list", "-w", "72", "--package", packageRoot])).toMatchObject({ command: "list", width: 72 });
    expect(parseArgs(["status", "--all", "--package", packageRoot])).toMatchObject({ command: "status", all: true, width: 100 });
    expect(parseArgs(["status", "-w", "72", "--package", packageRoot])).toMatchObject({ command: "status", width: 72 });
    expect(parseArgs(["info", "librarian", "--package", packageRoot])).toMatchObject({ command: "info", mode: "query", query: "librarian", width: 100 });
    expect(parseArgs(["info", "skill", "brainstorming", "--package", packageRoot])).toMatchObject({ command: "info", mode: "exact", type: "skill", name: "brainstorming", width: 100 });
    expect(parseArgs(["repair", "--package", packageRoot])).toMatchObject({ command: "repair", json: false });
    expect(() => parseArgs(["repair", "--global", "--package", packageRoot])).toThrow(/repair does not accept scope flags/i);
    expect(() => parseArgs(["repair", "--project", "--package", packageRoot])).toThrow(/repair does not accept scope flags/i);
    expect(() => parseArgs(["repair", "--all", "--package", packageRoot])).toThrow(/repair does not accept --all/i);
    expect(() => parseArgs(["repair", "--width", "80", "--package", packageRoot])).toThrow(/repair does not accept --width/i);
    expect(() => parseArgs(["repair", "-w", "80", "--package", packageRoot])).toThrow(/repair does not accept --width/i);
    expect(() => parseArgs(["repair", "skill", "librarian", "--package", packageRoot])).toThrow(/repair does not accept resource arguments/i);
    expect(() => parseArgs(["update", "--package", packageRoot])).toThrow(/Unknown command update/);
  });

  it("formats help as plain-language command blocks", () => {
    expect(HELP_TEXT).toContain("repair\n  Repair active resources everywhere relevant: global activations, indexed projects, and the current project when it has .pi/pi-ephemeral.json with activations.");
    expect(HELP_TEXT).toContain("Pattern: pi-ephemeral repair [--json]");
    expect(HELP_TEXT).toContain("Common flags");
    expect(HELP_TEXT).toContain("--package <dir>: explicit package/catalog root; overrides packageRoot from global pi-ephemeral config.");
    expect(HELP_TEXT).toContain("--agent-dir <dir>: Pi agent config dir; defaults to ~/.pi/agent, mainly for tests/alternate profiles.");
    expect(HELP_TEXT).toContain("--cwd <dir>: project context for project state resolution; defaults to current directory.");
    expect(HELP_TEXT).toContain("--json: machine-readable output for scripts; stable exact-command shape.");
    expect(HELP_TEXT).toContain("-w, --width <columns>: human table width; default 100.");
    expect(HELP_TEXT).toContain("Pattern: pi-ephemeral list [--filter <query>]");
    expect(HELP_TEXT).toContain("Pattern: pi-ephemeral info <type> <name>");
    expect(HELP_TEXT).toContain("        pi-ephemeral info <query>");

    const blocks = HELP_TEXT.trim().split("\n\n");
    const commandBlocks = blocks.filter((block) => /^(list|status|info|enable|disable|repair)\n/.test(block));
    expect(commandBlocks).toHaveLength(6);
    for (const block of commandBlocks) {
      expect(block).toMatch(/^[a-z]+\n/);
      expect(block).toContain("  Pattern:");
      expect(block).not.toContain("\n\n");
    }
    const commonFlags = blocks.find((block) => block.startsWith("Common flags\n"));
    expect(commonFlags).toBeDefined();
    expect(commonFlags).not.toContain("\n\n");
  });

  it("rejects short flags and plural resource types", () => {
    expect(() => parseArgs(["list", "-a", "--package", process.cwd()])).toThrow(/short flags/i);
    expect(() => parseArgs(["list", "--width", "abc", "--package", process.cwd()])).toThrow(/width/i);
    expect(() => parseArgs(["list", "librarian", "--package", process.cwd()])).toThrow(/Unexpected positional|usage/i);
    expect(() => parseArgs(["list", "--filter", "--json", "--package", process.cwd()])).toThrow(/--filter requires a value/i);
    expect(() => parseArgs(["status", "--filter", "librarian", "--package", process.cwd()])).toThrow(/--filter/i);
    expect(() => parseArgs(["info", "librarian", "--filter", "x", "--package", process.cwd()])).toThrow(/--filter/i);
    expect(() => parseArgs(["enable", "skill", "brainstorming", "--filter", "x", "--package", process.cwd()])).toThrow(/--filter/i);
    expect(() => parseArgs(["disable", "skill", "brainstorming", "--filter", "x", "--package", process.cwd()])).toThrow(/--filter/i);
    expect(() => parseArgs(["repair", "--filter", "x", "--package", process.cwd()])).toThrow(/--filter/i);
    expect(() => parseArgs(["repair", "skill", "brainstorming", "--filter", "x", "--package", process.cwd()])).toThrow(/resource arguments/i);
    expect(() => parseArgs(["info", "skill", "--package", process.cwd()])).toThrow(/usage/i);
    expect(() => parseArgs(["enable", "skills", "brainstorming", "--package", process.cwd()])).toThrow(/resource type/i);
  });

  it("rejects slash-only flags and misplaced flags", () => {
    expect(() => parseArgs(["/enable", "skill", "brainstorming", "--package", process.cwd()])).toThrow(/slash/i);
    expect(() => parseArgs(["enable", "--global", "skill", "brainstorming", "--package", process.cwd()])).toThrow(/usage/i);
  });

  it("uses global config packageRoot when --package is omitted", async () => {
    const dir = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(process.cwd(), "node_modules/.tmp-args-")));
    const agentDir = join(dir, "agent");
    const packageRoot = join(dir, "pkg");
    const fs = await import("node:fs/promises");
    await Promise.all([
      fs.mkdir(agentDir, { recursive: true }),
      fs.mkdir(join(packageRoot, "ephemeral"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(join(packageRoot, "resources.json"), JSON.stringify({ version: 1, resources: [] })),
      fs.writeFile(join(packageRoot, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [] })),
    ]);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(
      join(agentDir, "pi-ephemeral-global.json"),
      JSON.stringify({ version: 1, packageRoot: "../pkg", activations: [] }, null, 2) + "\n",
    ));

    expect(parseArgs(["repair", "--agent-dir", agentDir, "--cwd", dir])).toMatchObject({
      command: "repair",
      packageRoot,
    });
  });

  it("resolves relative packageRoot from the agent-dir path, not its realpath", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(join(process.cwd(), "node_modules/.tmp-args-symlink-"));
    const realAgentDir = join(dir, "real-agent");
    const symlinkParent = join(dir, "link-parent");
    const symlinkAgentDir = join(symlinkParent, "agent");
    const packageRootFromSymlink = join(symlinkParent, "pkg");
    await fs.mkdir(realAgentDir, { recursive: true });
    await fs.mkdir(join(packageRootFromSymlink, "ephemeral"), { recursive: true });
    await fs.mkdir(symlinkParent, { recursive: true });
    await fs.writeFile(join(packageRootFromSymlink, "resources.json"), JSON.stringify({ version: 1, resources: [] }));
    await fs.writeFile(join(packageRootFromSymlink, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [] }));
    await fs.writeFile(join(realAgentDir, "pi-ephemeral-global.json"), JSON.stringify({ version: 1, packageRoot: "../pkg", activations: [] }, null, 2) + "\n");
    await fs.symlink(realAgentDir, symlinkAgentDir);

    expect(parseArgs(["repair", "--agent-dir", symlinkAgentDir, "--cwd", dir])).toMatchObject({
      command: "repair",
      packageRoot: packageRootFromSymlink,
    });
  });

  it("requires package root when context cannot be inferred", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(join(process.cwd(), "node_modules/.tmp-args-empty-agent-"));
    const agentDir = join(dir, "agent");
    await fs.mkdir(agentDir, { recursive: true });

    expect(() => parseArgs(["list", "--agent-dir", agentDir, "--cwd", "/tmp/definitely-not-pi-ephemeral"])).toThrow(/--package/);
  });

  it("rejects conflicting scopes", () => {
    expect(() => parseArgs(["disable", "skill", "brainstorming", "--global", "--project", "--package", process.cwd()])).toThrow(/conflicting/i);
  });
});
