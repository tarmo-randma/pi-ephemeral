import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { refreshOnResourcesDiscover } from "../../src/extension/auto-refresh.js";
import { discoverHostPackageRoot } from "../../src/extension/host.js";

async function tempDir(prefix = "extension-host"): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-ephemeral-${prefix}-`));
}

async function fixture() {
  const root = await tempDir();
  const packageRoot = join(root, "pkg");
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const indexedProject = join(root, "indexed");
  await mkdir(join(packageRoot, "ephemeral", "skills", "brainstorming"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  await mkdir(join(indexedProject, ".pi"), { recursive: true });
  await writeFile(join(packageRoot, "resources.json"), JSON.stringify({ version: 1, resources: [] }));
  await writeFile(join(packageRoot, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [{ type: "skill", name: "brainstorming", path: "ephemeral/skills/brainstorming" }] }));
  await writeFile(join(packageRoot, "ephemeral", "skills", "brainstorming", "SKILL.md"), "# Brainstorming\n");
  await writeFile(join(agentDir, "pi-ephemeral-global.json"), JSON.stringify({ version: 1, activations: [{ type: "skill", name: "brainstorming", target: "skills/brainstorming" }] }));
  await writeFile(join(projectRoot, ".pi", "pi-ephemeral.json"), JSON.stringify({ version: 1, activations: [{ type: "skill", name: "brainstorming", target: ".pi/skills/brainstorming" }] }));
  await writeFile(join(indexedProject, ".pi", "pi-ephemeral.json"), "{ nope");
  await writeFile(join(agentDir, "pi-ephemeral-projects.json"), JSON.stringify({ version: 1, projects: [indexedProject] }));
  return { packageRoot, agentDir, projectRoot, indexedProject };
}

describe("extension host discovery", () => {
  it("discovers the unique pi-ephemeral host package base dir", () => {
    const pi = { getCommands: () => [{ name: "pi-ephemeral", source: "extension", sourceInfo: { baseDir: "/pkg" } }] };
    expect(discoverHostPackageRoot(pi as never)).toBe("/pkg");
  });

  it("ignores same-named prompt/skill commands when discovering the host package", () => {
    const pi = { getCommands: () => [
      { name: "pi-ephemeral", source: "prompt", sourceInfo: { baseDir: "/prompt-pack" } },
      { name: "pi-ephemeral", source: "skill", sourceInfo: { baseDir: "/skill-pack" } },
      { name: "pi-ephemeral", source: "extension", sourceInfo: { baseDir: "/extension-pack" } },
    ] };
    expect(discoverHostPackageRoot(pi as never)).toBe("/extension-pack");
  });

  it("fails clearly with zero or multiple host package base dirs", () => {
    expect(() => discoverHostPackageRoot({ getCommands: () => [] } as never)).toThrow(/No pi-ephemeral host package/);
    expect(() => discoverHostPackageRoot({ getCommands: () => [
      { name: "pi-ephemeral", source: "extension", sourceInfo: { baseDir: "/one" } },
      { name: "pi-ephemeral", source: "extension", sourceInfo: { baseDir: "/two" } },
    ] } as never)).toThrow(/Multiple pi-ephemeral host package/);
  });
});

describe("extension startup auto-refresh", () => {
  it("refreshes and applies only global and the current project on startup/reload", async () => {
    const fx = await fixture();
    const notify = vi.fn();
    await expect(readFile(join(fx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fx.projectRoot, ".pi", "skills", "brainstorming", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(refreshOnResourcesDiscover({ cwd: fx.projectRoot, reason: "startup" }, { cwd: fx.projectRoot, ui: { notify } } as never, { packageRoot: fx.packageRoot, agentDir: fx.agentDir })).resolves.toBeUndefined();

    await expect(readFile(join(fx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).resolves.toContain("Brainstorming");
    await expect(readFile(join(fx.projectRoot, ".pi", "skills", "brainstorming", "SKILL.md"), "utf8")).resolves.toContain("Brainstorming");
    await expect(readFile(join(fx.indexedProject, ".pi", "skills", "brainstorming", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/malformed|nope/i), expect.anything());
  });

  it("skips non startup/reload reasons without applying changes", async () => {
    const fx = await fixture();
    const notify = vi.fn();
    await expect(refreshOnResourcesDiscover({ cwd: fx.projectRoot, reason: "manual" }, { cwd: fx.projectRoot, ui: { notify } } as never, { packageRoot: fx.packageRoot, agentDir: fx.agentDir })).resolves.toBeUndefined();
    await expect(readFile(join(fx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fx.projectRoot, ".pi", "skills", "brainstorming", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("emits concise warnings when startup refresh cannot plan", async () => {
    const fx = await fixture();
    const notify = vi.fn();
    await expect(refreshOnResourcesDiscover({ cwd: fx.projectRoot, reason: "startup" }, { cwd: fx.projectRoot, ui: { notify } } as never, { packageRoot: join(fx.packageRoot, "missing"), agentDir: fx.agentDir })).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/pi-ephemeral.*refresh/i), "warning");
  });
});
