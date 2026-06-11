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
    expect(parseArgs(["repair", "--package", packageRoot])).toMatchObject({ command: "repair", all: false, json: false });
    expect(parseArgs(["repair", "skill", "librarian", "--global", "--package", packageRoot])).toMatchObject({ command: "repair", type: "skill", name: "librarian", scope: "global" });
    expect(() => parseArgs(["update", "--package", packageRoot])).toThrow(/Unknown command update/);
  });

  it("formats help as plain-language command blocks", () => {
    expect(HELP_TEXT).toContain("repair\n  Repair active resources after package or catalog changes.");
    expect(HELP_TEXT).toContain("Pattern: pi-ephemeral repair [<type> <name>] [--global|--project|--all]");
    expect(HELP_TEXT).toContain("Common flags");
    expect(HELP_TEXT).toContain("--package <dir>: package/catalog root; normally inferred, use for tests/manual package selection.");
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
    expect(() => parseArgs(["repair", "skill", "brainstorming", "--filter", "x", "--package", process.cwd()])).toThrow(/--filter/i);
    expect(() => parseArgs(["info", "skill", "--package", process.cwd()])).toThrow(/usage/i);
    expect(() => parseArgs(["enable", "skills", "brainstorming", "--package", process.cwd()])).toThrow(/resource type/i);
  });

  it("rejects slash-only flags and misplaced flags", () => {
    expect(() => parseArgs(["/enable", "skill", "brainstorming", "--package", process.cwd()])).toThrow(/slash/i);
    expect(() => parseArgs(["enable", "--global", "skill", "brainstorming", "--package", process.cwd()])).toThrow(/usage/i);
  });

  it("requires package root when context cannot be inferred", () => {
    expect(() => parseArgs(["list", "--cwd", "/tmp/definitely-not-pi-ephemeral"])).toThrow(/--package/);
  });

  it("rejects conflicting scopes", () => {
    expect(() => parseArgs(["disable", "skill", "brainstorming", "--global", "--project", "--package", process.cwd()])).toThrow(/conflicting/i);
  });
});
