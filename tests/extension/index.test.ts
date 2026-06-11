import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import piEphemeral from "../../src/index.js";

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
