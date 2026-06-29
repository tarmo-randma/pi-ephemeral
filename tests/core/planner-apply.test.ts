import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../../src/core/apply.js";
import { planDisable, planEnable, planUpdateAll, planUpdateTarget, planUpdateTargetAll } from "../../src/core/planner.js";
import { readActivationState } from "../../src/core/state.js";
import { loadProjectIndex } from "../../src/core/project-index.js";

async function tempDir(prefix = "planner"): Promise<string> {
  return mkdtemp(join(process.cwd(), `node_modules/.tmp-${prefix}-`));
}

async function writeCatalog(root: string, resources: Array<{ type: string; name: string; path: string }>): Promise<void> {
  await mkdir(join(root, "ephemeral", "skills"), { recursive: true });
  await mkdir(join(root, "ephemeral", "extensions"), { recursive: true });
  await writeFile(join(root, "resources.json"), JSON.stringify({ version: 1, resources: [] }));
  await writeFile(join(root, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources }));
}

async function skill(root: string, dirName: string): Promise<string> {
  const p = join(root, "ephemeral", "skills", dirName);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, "SKILL.md"), "# skill\n");
  return `ephemeral/skills/${dirName}`;
}

async function extension(root: string, fileName: string): Promise<string> {
  const p = join(root, "ephemeral", "extensions", fileName);
  await mkdir(join(root, "ephemeral", "extensions"), { recursive: true });
  await writeFile(p, "export default {};\n");
  return `ephemeral/extensions/${fileName}`;
}

async function context() {
  const root = await tempDir();
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const packageRoot = join(root, "pkg");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  return { root, agentDir, projectRoot, packageRoot };
}

describe("planner/apply", () => {
  it("enables a global resource and records applied changes", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "brainstorming", path: await skill(ctx.packageRoot, "brainstorming") }]);
    const plan = await planEnable({ ...ctx, scope: "global", type: "skill", name: "brainstorming" });
    expect(plan).toMatchObject({ ok: true, scope: "global", reloadRecommended: true });
    expect(plan.changes.map((c) => c.action)).toContain("create_symlink");
    const result = await applyPlan(plan);
    expect(result.applied.map((c) => c.action)).toEqual(plan.changes.map((c) => c.action));
    expect(await readFile(join(ctx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).toContain("skill");
    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "brainstorming", target: "skills/brainstorming" }] });
  });

  it("disables an activation whose catalog resource was removed", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "old", path: await skill(ctx.packageRoot, "old") }]);
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "old" }));
    await writeCatalog(ctx.packageRoot, []);
    const plan = await planDisable({ ...ctx, scope: "global", type: "skill", name: "old" });
    expect(plan.ok).toBe(true);
    await applyPlan(plan);
    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"))).resolves.toEqual({ version: 1, activations: [] });
  });

  it("rejects unsafe state targets before planning symlink removal", async () => {
    const ctx = await context();
    const outside = join(ctx.root, "outside");
    await writeFile(outside, "do not remove");
    await writeFile(join(ctx.agentDir, "pi-ephemeral-global.json"), JSON.stringify({
      version: 1,
      activations: [{ type: "skill", name: "escape", target: "../outside" }],
    }, null, 2) + "\n");

    await expect(planDisable({ ...ctx, scope: "global", type: "skill", name: "escape" })).rejects.toMatchObject({ code: "invalid_state", path: join(ctx.agentDir, "pi-ephemeral-global.json") });
    await expect(readFile(outside, "utf8")).resolves.toBe("do not remove");
  });

  it("does not create a project activation when a global activation exists", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "shared", path: await skill(ctx.packageRoot, "shared") }]);
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "shared" }));
    const plan = await planEnable({ ...ctx, scope: "project", type: "skill", name: "shared" });
    expect(plan).toMatchObject({ ok: true });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings[0]?.code).toBe("already_global");
    await applyPlan(plan);
    await expect(readActivationState(join(ctx.projectRoot, ".pi", "pi-ephemeral.json"))).resolves.toEqual({ version: 1, activations: [] });
  });

  it("promotes project activations to global and prunes indexed empty projects", async () => {
    const ctx = await context();
    const project2 = join(ctx.root, "project2");
    await mkdir(project2, { recursive: true });
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "promote", path: await skill(ctx.packageRoot, "promote") }]);
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "skill", name: "promote" }));
    await applyPlan(await planEnable({ ...ctx, projectRoot: project2, scope: "project", type: "skill", name: "promote" }));
    const plan = await planEnable({ ...ctx, scope: "global", type: "skill", name: "promote" });
    await applyPlan(plan);
    expect((await loadProjectIndex(join(ctx.agentDir, "pi-ephemeral-projects.json"))).projects).toEqual([]);
    await expect(readActivationState(join(ctx.projectRoot, ".pi", "pi-ephemeral.json"))).resolves.toEqual({ version: 1, activations: [] });
  });

  it("does not repeat catalog-global read-only warnings during update refresh", async () => {
    const ctx = await context();
    await writeFile(join(ctx.packageRoot, "resources.json"), JSON.stringify({
      version: 1,
      resources: [{ type: "extension", name: "manager", path: await extension(ctx.packageRoot, "manager.js") }],
    }));
    await writeFile(join(ctx.packageRoot, "ephemeral", "resources.json"), JSON.stringify({
      version: 1,
      resources: [
        { type: "skill", name: "one", path: await skill(ctx.packageRoot, "one") },
        { type: "skill", name: "two", path: await skill(ctx.packageRoot, "two") },
      ],
    }));
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "one" }));
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "two" }));

    const plan = await planUpdateAll(ctx);

    expect(plan.ok).toBe(true);
    expect(plan.warnings.filter((warning) => warning.code === "read_only_catalog")).toEqual([]);
  });

  it("updates target when source basename changes", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "renamed", path: await skill(ctx.packageRoot, "old-dir") }]);
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "renamed" }));
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "renamed", path: await skill(ctx.packageRoot, "new-dir") }]);
    await applyPlan(await planUpdateAll(ctx));
    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "renamed", target: "skills/new-dir" }] });
  });

  it("preserves global packageRoot when enable writes global state", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "rooted", path: await skill(ctx.packageRoot, "rooted") }]);
    await writeFile(join(ctx.agentDir, "pi-ephemeral-global.json"), JSON.stringify({
      version: 1,
      packageRoot: "../pkg",
      activations: [],
    }, null, 2) + "\n");

    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "rooted" }));

    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"), { scope: "global" })).resolves.toEqual({
      version: 1,
      packageRoot: "../pkg",
      activations: [{ type: "skill", name: "rooted", target: "skills/rooted" }],
    });
  });

  it("preserves global packageRoot when repair rewrites global state", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "moved", path: await skill(ctx.packageRoot, "new-moved") }]);
    await writeFile(join(ctx.agentDir, "pi-ephemeral-global.json"), JSON.stringify({
      version: 1,
      packageRoot: "../pkg",
      activations: [{ type: "skill", name: "moved", target: "skills/old-moved" }],
    }, null, 2) + "\n");

    await applyPlan(await planUpdateAll(ctx));

    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"), { scope: "global" })).resolves.toEqual({
      version: 1,
      packageRoot: "../pkg",
      activations: [{ type: "skill", name: "moved", target: "skills/new-moved" }],
    });
  });

  it("recreates stale symlink without rewriting unchanged state", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "stale", path: await skill(ctx.packageRoot, "stale") }]);
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "stale" }));
    const statePath = join(ctx.agentDir, "pi-ephemeral-global.json");
    const before = await readFile(statePath, "utf8");
    await rm(join(ctx.agentDir, "skills", "stale"));
    await symlink(resolve(ctx.packageRoot, await skill(ctx.packageRoot, "other-stale")), join(ctx.agentDir, "skills", "stale"));
    const plan = await planUpdateAll(ctx);
    expect(plan.changes.some((c) => c.action === "recreate_symlink")).toBe(true);
    await applyPlan(plan);
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("fails on unmanaged target conflicts", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "conflict", path: await skill(ctx.packageRoot, "conflict") }]);
    await mkdir(join(ctx.agentDir, "skills"), { recursive: true });
    await writeFile(join(ctx.agentDir, "skills", "conflict"), "user file");
    const plan = await planEnable({ ...ctx, scope: "global", type: "skill", name: "conflict" });
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]?.code).toBe("unmanaged_target");
    await expect(applyPlan(plan)).rejects.toThrow(/not ok/);
  });

  it("fails affected duplicate identity and target collision resources", async () => {
    const ctx = await context();
    const pathA = await skill(ctx.packageRoot, "dupe");
    await writeCatalog(ctx.packageRoot, [
      { type: "skill", name: "dup", path: pathA },
      { type: "skill", name: "dup", path: pathA },
      { type: "skill", name: "other", path: pathA },
    ]);
    const duplicate = await planEnable({ ...ctx, scope: "global", type: "skill", name: "dup" });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors.some((e) => e.code === "duplicate_catalog_entry" || e.code === "duplicate_identity")).toBe(true);
    const collision = await planEnable({ ...ctx, scope: "global", type: "skill", name: "other" });
    expect(collision.ok).toBe(false);
    expect(collision.errors.some((e) => e.code === "target_collision")).toBe(true);
  });

  it("comprehensive repair includes current project and indexes it when it has activations", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "skill", name: "current", path: await skill(ctx.packageRoot, "current") }]);
    await mkdir(join(ctx.projectRoot, ".pi"), { recursive: true });
    await writeFile(join(ctx.projectRoot, ".pi", "pi-ephemeral.json"), JSON.stringify({
      version: 1,
      activations: [{ type: "skill", name: "current", target: ".pi/skills/current" }],
    }, null, 2) + "\n");

    const plan = await planUpdateAll(ctx);
    expect(plan.ok).toBe(true);
    expect(plan.changes.some((change) => change.action === "create_symlink" && change.scope === "project")).toBe(true);
    expect(plan.changes.some((change) => change.action === "write_project_index")).toBe(true);
    await applyPlan(plan);

    expect((await loadProjectIndex(join(ctx.agentDir, "pi-ephemeral-projects.json"))).projects).toEqual([ctx.projectRoot]);
    await expect(readFile(join(ctx.projectRoot, ".pi", "skills", "current", "SKILL.md"), "utf8")).resolves.toContain("skill");
  });

  it("prunes stale project index entries during update all", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [{ type: "extension", name: "ext", path: await extension(ctx.packageRoot, "ext.js") }]);
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "extension", name: "ext" }));
    const missing = join(ctx.root, "missing-project");
    await writeFile(join(ctx.agentDir, "pi-ephemeral-projects.json"), JSON.stringify({ version: 1, projects: [ctx.projectRoot, missing] }, null, 2) + "\n");
    await applyPlan(await planUpdateAll(ctx));
    expect((await loadProjectIndex(join(ctx.agentDir, "pi-ephemeral-projects.json"))).projects).toEqual([ctx.projectRoot]);
  });

  it("targeted update writes only requested activation state changes", async () => {
    const ctx = await context();
    await writeCatalog(ctx.packageRoot, [
      { type: "skill", name: "requested", path: await skill(ctx.packageRoot, "requested-old") },
      { type: "skill", name: "unrelated", path: await skill(ctx.packageRoot, "unrelated-old") },
    ]);
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "requested" }));
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "unrelated" }));
    await writeCatalog(ctx.packageRoot, [
      { type: "skill", name: "requested", path: await skill(ctx.packageRoot, "requested-new") },
      { type: "skill", name: "unrelated", path: await skill(ctx.packageRoot, "unrelated-new") },
    ]);

    const plan = await planUpdateTarget(ctx, "skill", "requested", "global");
    expect(plan.ok).toBe(true);
    expect(plan.changes.every((change) => change.identity === "skill:requested" || change.action === "write_state")).toBe(true);
    await applyPlan(plan);

    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"))).resolves.toEqual({
      version: 1,
      activations: [
        { type: "skill", name: "requested", target: "skills/requested-new" },
        { type: "skill", name: "unrelated", target: "skills/unrelated-old" },
      ],
    });
    await expect(readFile(join(ctx.agentDir, "skills", "requested-new", "SKILL.md"), "utf8")).resolves.toContain("skill");
    await expect(readFile(join(ctx.agentDir, "skills", "unrelated-old", "SKILL.md"), "utf8")).resolves.toContain("skill");
    await expect(readFile(join(ctx.agentDir, "skills", "unrelated-new", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("targeted update all refreshes indexed projects, preserves unrelated activations, and prunes stale index entries", async () => {
    const ctx = await context();
    const project2 = join(ctx.root, "project2");
    const missingProject = join(ctx.root, "missing-project");
    await mkdir(project2, { recursive: true });
    await writeCatalog(ctx.packageRoot, [
      { type: "skill", name: "requested", path: await skill(ctx.packageRoot, "requested-old") },
      { type: "skill", name: "unrelated", path: await skill(ctx.packageRoot, "unrelated-old") },
    ]);
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "requested" }));
    await mkdir(join(project2, ".pi"), { recursive: true });
    await writeFile(join(project2, ".pi", "pi-ephemeral.json"), JSON.stringify({ version: 1, activations: [{ type: "skill", name: "requested", target: ".pi/skills/requested-old" }] }, null, 2) + "\n");
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "skill", name: "unrelated" }));
    await writeFile(join(ctx.agentDir, "pi-ephemeral-projects.json"), JSON.stringify({ version: 1, projects: [ctx.projectRoot, project2, missingProject] }, null, 2) + "\n");
    await writeCatalog(ctx.packageRoot, [
      { type: "skill", name: "requested", path: await skill(ctx.packageRoot, "requested-new") },
      { type: "skill", name: "unrelated", path: await skill(ctx.packageRoot, "unrelated-new") },
    ]);

    const plan = await planUpdateTargetAll(ctx, "skill", "requested");
    expect(plan.ok).toBe(true);
    expect(plan.scope).toBe("mixed");
    expect(plan.activations?.map((activation) => activation.projectRoot).filter(Boolean)).toEqual([ctx.projectRoot, project2]);
    await applyPlan(plan);

    await expect(readActivationState(join(ctx.agentDir, "pi-ephemeral-global.json"))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "requested", target: "skills/requested-new" }] });
    await expect(readActivationState(join(project2, ".pi", "pi-ephemeral.json"))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "requested", target: ".pi/skills/requested-new" }] });
    await expect(readActivationState(join(ctx.projectRoot, ".pi", "pi-ephemeral.json"))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "unrelated", target: ".pi/skills/unrelated-old" }] });
    expect((await loadProjectIndex(join(ctx.agentDir, "pi-ephemeral-projects.json"))).projects).toEqual([ctx.projectRoot, project2]);
    await expect(readFile(join(ctx.projectRoot, ".pi", "skills", "unrelated-new", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
