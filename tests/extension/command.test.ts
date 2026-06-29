import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  return { cwd: projectRoot, mode: "print", ui: { notify: vi.fn() } } as never;
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
    expect(enabled).toMatch(/Reload recommended/);
    await expect(readFile(join(fx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).resolves.toContain("Brainstorming");

    const status = await handleSlashCommand("status --json", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(status).toBeDefined();
    expect(JSON.parse(status!)).toMatchObject({ command: "status", global: [{ type: "skill", name: "brainstorming" }] });

    await handleSlashCommand("disable skill brainstorming --global", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    const info = await handleSlashCommand("info skill brainstorming", ctx(fx.projectRoot), { packageRoot: fx.packageRoot, agentDir: fx.agentDir });
    expect(info).toContain("Type        : skill");
    expect(info).toContain("Action      : enable");
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
    expect(notify).toHaveBeenCalledWith("Pi-ephemeral changes cancelled.", "info");
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
