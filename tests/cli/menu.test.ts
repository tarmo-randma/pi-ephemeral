import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

// The terminal host reports saved/cancelled/unchanged independently of stdout so actions never guess.
describe("terminal menu CLI", () => {
  it.each([["applied", 0], ["unchanged", 3], ["cancelled", 130]])("returns the %s outcome", async (result, status) => {
    vi.resetModules();
    const launchTerminalMenu = vi.fn(async () => result);
    vi.doMock("../../src/tui/terminal-menu.js", () => ({ launchTerminalMenu }));
    const { runCli } = await import("../../src/cli.js");
    const stdout = vi.fn();
    expect(await runCli(["menu", "--package", process.cwd(), "--cwd", process.cwd(), "--global"], { stdout, stderr: vi.fn() })).toBe(status);
    expect(launchTerminalMenu).toHaveBeenCalledWith(expect.objectContaining({ scope: "global", projectRoot: process.cwd() }));
    vi.doUnmock("../../src/tui/terminal-menu.js");
  });

  // JSON commands must remain non-interactive, and menu must not silently accept misleading output flags.
  it("accepts the existing context flags and rejects JSON menu output", () => {
    expect(parseArgs(["menu", "--package", process.cwd()])).toMatchObject({ command: "menu", scope: "project" });
    expect(() => parseArgs(["menu", "--json", "--package", process.cwd()])).toThrow("only scope and context flags");
  });
});
