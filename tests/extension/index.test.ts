import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import piEphemeral from "../../src/pi-ephemeral.js";
import { handleSlashCommand } from "../../src/extension/command.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-ephemeral-extension-index-"));
  const packageRoot = join(root, "pkg");
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  await mkdir(join(packageRoot, "ephemeral", "skills", "brainstorming"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(packageRoot, "resources.json"), JSON.stringify({ version: 1, resources: [] }));
  await writeFile(join(packageRoot, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [{ type: "skill", name: "brainstorming", path: "ephemeral/skills/brainstorming" }] }));
  await writeFile(join(packageRoot, "ephemeral", "skills", "brainstorming", "SKILL.md"), "# Brainstorming\n");
  await writeFile(join(agentDir, "pi-ephemeral-global.json"), JSON.stringify({ version: 1, activations: [] }));
  return { packageRoot, agentDir, projectRoot };
}

describe("extension default export wiring", () => {
  // Reload replaces the extension context even on failure; the full command wrapper must not reuse it.
  it.each([
    ["enable", false], ["disable", false], ["enable", true], ["disable", true],
  ] as const)("does not reuse stale context after %s reload (failure: %s)", async (action, failReload) => {
    const fx = await fixture();
    if (action === "disable") {
      await handleSlashCommand("enable skill brainstorming --global", {
        cwd: fx.projectRoot, mode: "rpc", ui: { notify: vi.fn() },
        waitForIdle: async () => {}, reload: async () => {},
      } as never, fx);
    }
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fx.agentDir;
    let handler!: (args: string, ctx: never) => Promise<void>;
    piEphemeral({
      getCommands: () => [{ name: "pi-ephemeral", source: "extension", sourceInfo: { baseDir: fx.packageRoot } }],
      registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
      on: vi.fn(),
    } as never);
    let stale = false;
    const notify = vi.fn(() => { expect(stale).toBe(false); });
    const context = new Proxy({
      cwd: fx.projectRoot, mode: "rpc", ui: { notify }, waitForIdle: async () => {},
      reload: vi.fn(async () => {
        stale = true;
        if (failReload) throw new Error("reload unavailable");
      }),
    }, {
      get(target, key, receiver) {
        if (stale) throw new Error(`Stale context access: ${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const result = handler(`${action} skill brainstorming --global --json`, context as never);
      if (failReload) {
        await expect(result).rejects.toThrow("Activation saved on disk, but current-session resource reload failed: reload unavailable");
      } else {
        await expect(result).resolves.toBeUndefined();
      }
      expect(stale).toBe(true);
      expect(notify).toHaveBeenCalledOnce();
      const target = join(fx.agentDir, "skills", "brainstorming", "SKILL.md");
      if (action === "enable") await expect(access(target)).resolves.toBeUndefined();
      else await expect(access(target)).rejects.toThrow();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("registers the slash command and resources_discover handler and delegates both", async () => {
    const fx = await fixture();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fx.agentDir;
    const notify = vi.fn();
    const registeredCommands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }> = {};
    const handlers: Record<string, (event: never, ctx: never) => Promise<unknown>> = {};
    const pi = {
      getCommands: vi.fn(() => [{ name: "pi-ephemeral", source: "extension", sourceInfo: { baseDir: fx.packageRoot } }]),
      registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => {
        registeredCommands[name] = command;
      }),
      on: vi.fn((event: string, handler: (event: never, ctx: never) => Promise<unknown>) => {
        handlers[event] = handler;
      }),
    };

    try {
      piEphemeral(pi as never);
      expect(pi.registerCommand).toHaveBeenCalledWith("pi-ephemeral", expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }));
      expect(pi.on).toHaveBeenCalledWith("resources_discover", expect.any(Function));

      await expect(registeredCommands["pi-ephemeral"]!.handler("status", { cwd: fx.projectRoot, mode: "print", ui: { notify } } as never)).resolves.toBeUndefined();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Status:"), "info");
      await expect(handlers.resources_discover!({ cwd: fx.projectRoot, reason: "startup" } as never, { cwd: fx.projectRoot, ui: { notify } } as never)).resolves.toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
