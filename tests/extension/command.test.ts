import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleSlashCommand, parseSlashArgs } from "../../src/extension/command.js";

async function tempDir(prefix = "extension-command"): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-ephemeral-${prefix}-`));
}

async function fixture() {
  const root = await tempDir();
  const packageRoot = join(root, "pkg");
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  await mkdir(join(packageRoot, "ephemeral", "skills", "brainstorming"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(packageRoot, "resources.json"), JSON.stringify({ version: 1, resources: [] }));
  await writeFile(join(packageRoot, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [{ type: "skill", name: "brainstorming", path: "ephemeral/skills/brainstorming" }] }));
  await writeFile(join(packageRoot, "ephemeral", "skills", "brainstorming", "SKILL.md"), "# Brainstorming\n");
  return { packageRoot, agentDir, projectRoot };
}

function ctx(projectRoot: string) {
  return { cwd: projectRoot, mode: "print", ui: { notify: vi.fn() }, waitForIdle: vi.fn(async () => {}), reload: vi.fn(async () => {}) } as never;
}

describe("extension slash command", () => {
  it("parses the CLI text surface without CLI-only context flags", () => {
    expect(parseSlashArgs("enable skill brainstorming --global --json")).toMatchObject({ command: "enable", type: "skill", name: "brainstorming", scope: "global", json: true });
    expect(parseSlashArgs("list --all --json")).toMatchObject({ command: "list", all: true, json: true });
    expect(parseSlashArgs("list --filter librarian")).toMatchObject({ command: "list", filter: "librarian" });
    expect(parseSlashArgs("status --all")).toMatchObject({ command: "status", all: true });
    expect(parseSlashArgs("info librarian")).toMatchObject({ command: "info", mode: "query", query: "librarian" });
    expect(parseSlashArgs("info skill brainstorming")).toMatchObject({ command: "info", mode: "exact", type: "skill", name: "brainstorming" });
    expect(parseSlashArgs("list --width 80")).toMatchObject({ command: "list", width: 80 });
    expect(parseSlashArgs("list -w 80")).toMatchObject({ command: "list", width: 80 });
    expect(parseSlashArgs("disable skill brainstorming --project")).toMatchObject({ command: "disable", type: "skill", name: "brainstorming", scope: "project" });
    expect(parseSlashArgs("repair --json")).toMatchObject({ command: "repair", json: true });
    expect(() => parseSlashArgs("repair --global")).toThrow(/repair does not accept scope flags/i);
    expect(() => parseSlashArgs("repair --all")).toThrow(/repair does not accept --all/i);
    expect(() => parseSlashArgs("repair skill brainstorming")).toThrow(/repair does not accept resource arguments/i);

    expect(() => parseSlashArgs("enable skill foo --cwd /tmp")).toThrow(/CLI-only/);
    expect(() => parseSlashArgs("enable skill foo --package /tmp")).toThrow(/CLI-only/);
    expect(() => parseSlashArgs("enable skill foo --agent-dir /tmp")).toThrow(/CLI-only/);
    expect(() => parseSlashArgs("enable skills foo")).toThrow(/Invalid resource type/);
    expect(() => parseSlashArgs("enable skill foo -g")).toThrow(/Short flags/);
  });

  it("returns text status/help outside TUI and applies text operations", async () => {
    const fx = await fixture();
    const help = await handleSlashCommand("", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(help).toMatch(/Pattern:/);

    const enabled = await handleSlashCommand("enable skill brainstorming --global", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(enabled).toBeUndefined();
    await expect(readFile(join(fx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).resolves.toContain("Brainstorming");

    const status = await handleSlashCommand("status --json", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(status).toBeDefined();
    expect(JSON.parse(status!)).toMatchObject({ command: "status", global: [{ type: "skill", name: "brainstorming" }] });

    await handleSlashCommand("disable skill brainstorming --global", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    const info = await handleSlashCommand("info skill brainstorming", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(info).toContain("Type        : skill");
    expect(info).toContain("Action      : enable");
  });

  // A running turn must finish before activation changes, and reload must see the new disk state.
  it.each(["enable", "disable"])("waits before %s and notifies before reloading", async (action) => {
    const fx = await fixture();
    const runtime = { packageRoot: fx.packageRoot, agentDir: fx.agentDir };
    const target = join(fx.agentDir, "skills", "brainstorming", "SKILL.md");
    if (action === "disable") await handleSlashCommand("enable skill brainstorming --global", ctx(fx.projectRoot), runtime);
    let finishTurn!: () => void;
    const idle = new Promise<void>((resolve) => { finishTurn = resolve; });
    const notify = vi.fn();
    const reload = vi.fn(async () => {
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Reloading current session"), "info");
      expect(notify.mock.calls[0]?.[0]).not.toContain("Reload recommended");
      if (action === "enable") await expect(access(target)).resolves.toBeUndefined();
      else await expect(access(target)).rejects.toThrow();
    });
    const waitForIdle = vi.fn(() => idle);
    const result = handleSlashCommand(`${action} skill brainstorming --global`, {
      cwd: fx.projectRoot, mode: "rpc", ui: { notify }, waitForIdle, reload,
    } as never, runtime);
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    if (action === "enable") await expect(access(target)).rejects.toThrow();
    else await expect(access(target)).resolves.toBeUndefined();
    finishTurn();
    await expect(result).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledOnce();
  });

  // Inspection and repair retain their existing command behavior; only enable/disable trigger reload.
  it("does not wait or reload for non-activation commands or failed activation", async () => {
    const fx = await fixture();
    const runtime = { packageRoot: fx.packageRoot, agentDir: fx.agentDir };
    const waitForIdle = vi.fn(async () => {});
    const reload = vi.fn(async () => {});
    const context = { cwd: fx.projectRoot, mode: "rpc", ui: { notify: vi.fn() }, waitForIdle, reload } as never;
    for (const args of ["", "list", "status", "info skill brainstorming", "repair"]) {
      expect(await handleSlashCommand(args, context, runtime)).toBeTruthy();
    }
    expect(waitForIdle).not.toHaveBeenCalled();
    await expect(handleSlashCommand("enable skill missing", context, runtime)).rejects.toThrow();
    await expect(handleSlashCommand("disable skills invalid", context, runtime)).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  // If waiting fails, no activation should be written and no reload should be attempted.
  it("leaves disk untouched when waiting for idle fails", async () => {
    const fx = await fixture();
    const reload = vi.fn();
    await expect(handleSlashCommand("enable skill brainstorming --global", {
      cwd: fx.projectRoot, mode: "rpc", ui: { notify: vi.fn() },
      waitForIdle: async () => { throw new Error("idle failed"); }, reload,
    } as never, fx)).rejects.toThrow("idle failed");
    await expect(access(join(fx.agentDir, "skills", "brainstorming"))).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it("runs slash repair against global, current project, and indexed projects", async () => {
    const fx = await fixture();
    const indexedProject = join(fx.projectRoot, "indexed");
    await mkdir(join(indexedProject, ".pi"), { recursive: true });
    await handleSlashCommand("enable skill brainstorming --project", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    await writeFile(join(indexedProject, ".pi", "pi-ephemeral.json"), JSON.stringify({ version: 1, activations: [{ type: "skill", name: "brainstorming", target: ".pi/skills/brainstorming" }] }, null, 2) + "\n");
    await writeFile(join(fx.agentDir, "pi-ephemeral-projects.json"), JSON.stringify({ version: 1, projects: [fx.projectRoot, indexedProject] }, null, 2) + "\n");

    const result = await handleSlashCommand("repair --json", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(result).toBeDefined();
    expect(JSON.parse(result!)).toMatchObject({
      command: "repair",
      plan: {
        ok: true,
        activations: [
          { scope: "global", activations: [] },
          { scope: "project", projectRoot: fx.projectRoot, activations: [{ type: "skill", name: "brainstorming" }] },
          { scope: "project", projectRoot: indexedProject, activations: [{ type: "skill", name: "brainstorming" }] },
        ],
      },
    });
  });

  it("launches the Milestone 6 TUI as a focused overlay only for TUI launch invocations", async () => {
    const fx = await fixture();
    const notify = vi.fn();
    const custom = vi.fn(async () => "cancelled");
    const result = await handleSlashCommand("--global", { cwd: fx.projectRoot, mode: "tui", ui: { notify, custom } } as never, { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(result).toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true, onHandle: expect.any(Function) }));
    const launchOptions = (custom.mock.calls as unknown[][])[0]?.[1] as { onHandle: (handle: { focus: () => void }) => void };
    const focus = vi.fn();
    launchOptions.onHandle({ focus });
    expect(focus).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("Pi-ephemeral changes cancelled. No further changes saved.", "info");
  });

  // Menu saves and the explicit RPC-safe command must share the current-session reload flow.
  it("reloads after an overlay save and from the explicit reload command, never after cancel or failure", async () => {
    const fx = await fixture();
    for (const outcome of ["applied", "cancelled", "unchanged", "failed"] as const) {
      const context = { cwd: fx.projectRoot, mode: "tui", ui: { notify: vi.fn(), custom: vi.fn(async () => outcome) }, waitForIdle: vi.fn(), reload: vi.fn() };
      await handleSlashCommand("", context as never, fx);
      expect(context.reload).toHaveBeenCalledTimes(outcome === "applied" ? 1 : 0);
      if (outcome === "failed") expect(context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("some changes may have been written"), "error");
    }
    const context = { cwd: fx.projectRoot, mode: "rpc", ui: { notify: vi.fn() }, waitForIdle: vi.fn(), reload: vi.fn() };
    await handleSlashCommand("reload", context as never, fx);
    expect(context.waitForIdle).toHaveBeenCalledOnce();
    expect(context.reload).toHaveBeenCalledOnce();
    expect(() => parseSlashArgs("menu")).toThrow("CLI-only");
  });

  // Reload may invalidate UI methods even when it fails; report the failure without using them again.
  it("does not reuse the old context after reload fails", async () => {
    const fx = await fixture();
    let invalid = false;
    const notify = vi.fn(() => { if (invalid) throw new Error("stale UI"); });
    await expect(handleSlashCommand("reload", {
      cwd: fx.projectRoot, mode: "rpc", ui: { notify }, waitForIdle: vi.fn(),
      reload: async () => { invalid = true; throw new Error("reload broke"); },
    } as never, fx)).rejects.toThrow("Current-session resource reload failed: reload broke");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("resolves the git project root before launching the TUI", async () => {
    vi.resetModules();
    const fx = await fixture();
    const subdir = join(fx.projectRoot, "packages", "app");
    await mkdir(subdir, { recursive: true });
    const resolveProjectRoot = vi.fn(async () => fx.projectRoot);
    const launchResourceManagerTui = vi.fn(async () => undefined);
    vi.doMock("../../src/core/project-index.js", async () => ({
      ...(await vi.importActual<typeof import("../../src/core/project-index.js")>("../../src/core/project-index.js")),
      resolveProjectRoot,
    }));
    vi.doMock("../../src/tui/resource-manager.js", () => ({ launchResourceManagerTui }));
    const { handleSlashCommand: mockedHandleSlashCommand } = await import("../../src/extension/command.js");

    await expect(mockedHandleSlashCommand("", { cwd: subdir, mode: "tui", ui: { notify: vi.fn() } } as never, { packageRoot: fx.packageRoot, agentDir: fx.agentDir })).resolves.toBeUndefined();

    expect(resolveProjectRoot).toHaveBeenCalledWith(subdir);
    expect(launchResourceManagerTui).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ projectRoot: fx.projectRoot, scope: "project" }));
    vi.doUnmock("../../src/core/project-index.js");
    vi.doUnmock("../../src/tui/resource-manager.js");
  });
});
