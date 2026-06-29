import { mkdir, lstat, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readActivationState, StateFileError, writeActivationState } from "../../src/core/state.js";
import { loadProjectIndex, updateProjectIndex } from "../../src/core/project-index.js";

async function tempDir(): Promise<string> {
  return await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(process.cwd(), "node_modules/.tmp-state-")));
}

describe("activation state files", () => {
  it("reads missing state without creating it", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "missing.json");
    await expect(readActivationState(statePath)).resolves.toEqual({ version: 1, activations: [] });
    await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes canonical activation JSON lazily", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "nested", "state.json");
    const changed = await writeActivationState(statePath, { version: 1, activations: [
      { type: "skill", name: "z", target: "skills/z" },
      { type: "extension", name: "a", target: "extensions/a.js" },
    ] });
    expect(changed).toBe(true);
    await expect(readFile(statePath, "utf8")).resolves.toBe(JSON.stringify({ version: 1, activations: [
      { type: "extension", name: "a", target: "extensions/a.js" },
      { type: "skill", name: "z", target: "skills/z" },
    ] }, null, 2) + "\n");
  });

  it("reads optional global packageRoot while preserving activations", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "pi-ephemeral-global.json");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      packageRoot: "../../Projects/my-infrastructure/pi-package",
      activations: [{ type: "skill", name: "x", target: "skills/x" }],
    }));

    await expect(readActivationState(statePath, { scope: "global" })).resolves.toEqual({
      version: 1,
      packageRoot: "../../Projects/my-infrastructure/pi-package",
      activations: [{ type: "skill", name: "x", target: "skills/x" }],
    });
  });

  it("rejects blank global packageRoot", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "pi-ephemeral-global.json");
    await writeFile(statePath, JSON.stringify({ version: 1, packageRoot: " ", activations: [] }));

    await expect(readActivationState(statePath, { scope: "global" })).rejects.toMatchObject({
      name: "StateFileError",
      path: statePath,
      code: "invalid_state",
    });
  });

  it("rejects packageRoot in project state", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "pi-ephemeral.json");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      packageRoot: "../pkg",
      activations: [{ type: "skill", name: "x", target: ".pi/skills/x" }],
    }));

    await expect(readActivationState(statePath, { scope: "project" })).rejects.toMatchObject({
      name: "StateFileError",
      path: statePath,
      code: "invalid_state",
    });
  });

  it("does not rewrite unchanged canonical content", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "state.json");
    await writeActivationState(statePath, { version: 1, activations: [{ type: "skill", name: "a", target: "skills/a" }] });
    const before = (await stat(statePath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const changed = await writeActivationState(statePath, { version: 1, activations: [{ type: "skill", name: "a", target: "skills/a" }] });
    expect(changed).toBe(false);
    expect((await stat(statePath)).mtimeMs).toBe(before);
  });

  it("preserves symlinked state files by writing through", async () => {
    const dir = await tempDir();
    const repoState = join(dir, "repo", "pi-ephemeral-global.json");
    const liveState = join(dir, "agent", "pi-ephemeral-global.json");
    await mkdir(join(dir, "repo"), { recursive: true });
    await mkdir(join(dir, "agent"), { recursive: true });
    await writeFile(repoState, JSON.stringify({ version: 1, activations: [] }, null, 2) + "\n");
    await symlink(repoState, liveState);
    await writeActivationState(liveState, { version: 1, activations: [{ type: "skill", name: "x", target: "skills/x" }] });
    expect((await lstat(liveState)).isSymbolicLink()).toBe(true);
    expect(await readFile(repoState, "utf8")).toContain('"activations"');
    expect(await readFile(repoState, "utf8")).toContain('"name": "x"');
  });

  it("throws typed errors for malformed JSON with path", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "bad.json");
    await writeFile(statePath, "{ nope");
    await expect(readActivationState(statePath)).rejects.toMatchObject({ name: "StateFileError", path: statePath, code: "malformed_state_json" });
    await expect(readActivationState(statePath)).rejects.toBeInstanceOf(StateFileError);
  });

  it("rejects invalid activation types and unsafe targets with typed errors", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "state.json");
    const unsafeTargets = ["", "/skills/a", "skills\\a", "skills//a", "skills/../a", "other/a", ".pi/skills/a"];
    for (const [index, target] of unsafeTargets.entries()) {
      await writeFile(statePath, JSON.stringify({ version: 1, activations: [{ type: "skill", name: `bad-${index}`, target }] }));
      await expect(readActivationState(statePath, { scope: "global" })).rejects.toMatchObject({ name: "StateFileError", path: statePath, code: "invalid_state" });
    }

    await writeFile(statePath, JSON.stringify({ version: 1, activations: [{ type: "unknown", name: "bad-type", target: "skills/a" }] }));
    await expect(readActivationState(statePath, { scope: "global" })).rejects.toMatchObject({ name: "StateFileError", path: statePath, code: "invalid_state" });
  });

  it("requires project activation targets to stay under project managed prefixes", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({ version: 1, activations: [{ type: "skill", name: "project", target: ".pi/skills/project" }] }));
    await expect(readActivationState(statePath, { scope: "project" })).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "project", target: ".pi/skills/project" }] });

    await writeFile(statePath, JSON.stringify({ version: 1, activations: [{ type: "skill", name: "global", target: "skills/global" }] }));
    await expect(readActivationState(statePath, { scope: "project" })).rejects.toMatchObject({ name: "StateFileError", path: statePath, code: "invalid_state" });
  });
});

describe("project index files", () => {
  it("loads missing index without creating it and writes sorted canonical paths", async () => {
    const dir = await tempDir();
    const indexPath = join(dir, "pi-ephemeral-projects.json");
    await expect(loadProjectIndex(indexPath)).resolves.toEqual({ version: 1, projects: [] });
    await updateProjectIndex(indexPath, ["/b", "/a", "/b"]);
    expect(await readFile(indexPath, "utf8")).toBe(JSON.stringify({ version: 1, projects: ["/a", "/b"] }, null, 2) + "\n");
  });
});
