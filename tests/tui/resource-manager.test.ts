import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { applyPendingResourceChanges, buildResourceManagerViewModel, ResourceManagerComponent, type PendingResourceToggle } from "../../src/tui/resource-manager.js";
import { applyPlan } from "../../src/core/apply.js";
import { loadCatalogSet } from "../../src/core/catalog.js";
import { globalStatePath, projectStatePath } from "../../src/core/project-index.js";
import { planEnable } from "../../src/core/planner.js";
import type { ActivationState } from "../../src/core/state.js";

async function tempDir(prefix = "tui"): Promise<string> {
  return mkdtemp(join(process.cwd(), `node_modules/.tmp-${prefix}-`));
}

async function context() {
  const root = await tempDir();
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const packageRoot = join(root, "pkg");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "grill-me"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "librarian"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "pi-intercom"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "pi-web-access"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "prompts"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "extensions", "pi-intercom"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "extensions", "pi-web-access"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "using-superpowers"), { recursive: true });
  await writeFile(join(packageRoot, "ephemeral", "skills", "grill-me", "SKILL.md"), "# grill me\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "librarian", "SKILL.md"), "# librarian\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "pi-intercom", "SKILL.md"), "# pi intercom\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "pi-web-access", "SKILL.md"), "# pi web access\n");
  await writeFile(join(packageRoot, "ephemeral", "extensions", "pi-intercom", "index.ts"), "export {};\n");
  await writeFile(join(packageRoot, "ephemeral", "extensions", "pi-web-access", "index.ts"), "export {};\n");
  await writeFile(join(packageRoot, "ephemeral", "prompts", "web-research.md"), "web research\n");
  await writeFile(join(packageRoot, "skills", "using-superpowers", "SKILL.md"), "# using superpowers\n");
  await writeFile(join(packageRoot, "resources.json"), JSON.stringify({ version: 1, resources: [
    { type: "skill", name: "using-superpowers", path: "skills/using-superpowers", bundle: "pi-web-access", description: "always common helper" },
  ] }));
  await writeFile(join(packageRoot, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [
    { type: "extension", name: "pi-intercom", path: "ephemeral/extensions/pi-intercom", bundle: "pi-intercom", description: "chat bridge" },
    { type: "skill", name: "pi-intercom", path: "ephemeral/skills/pi-intercom", bundle: "pi-intercom", description: "intercom helper" },
    { type: "extension", name: "pi-web-access", path: "ephemeral/extensions/pi-web-access", bundle: "pi-web-access", description: "browser extension" },
    { type: "skill", name: "librarian", path: "ephemeral/skills/librarian", bundle: "pi-web-access", description: "Evidence-backed open-source library research" },
    { type: "skill", name: "pi-web-access", path: "ephemeral/skills/pi-web-access", bundle: "pi-web-access", description: "web access skill" },
    { type: "prompt", name: "web-research", path: "ephemeral/prompts/web-research.md", bundle: "pi-web-access", description: "prompt research" },
    { type: "skill", name: "grill-me", path: "ephemeral/skills/grill-me", description: "unbundled critique" },
  ] }));
  return { root, agentDir, projectRoot, packageRoot };
}

async function readState(path: string): Promise<ActivationState> {
  return JSON.parse(await readFile(path, "utf8")) as ActivationState;
}

async function addHeightFixtureResources(packageRoot: string): Promise<void> {
  const resourcesPath = join(packageRoot, "ephemeral", "resources.json");
  const catalog = JSON.parse(await readFile(resourcesPath, "utf8")) as { version: 1; resources: Array<{ type: "skill"; name: string; path: string; bundle: string; description: string }> };
  const extraResources = Array.from({ length: 15 }, (_, index) => {
    const name = `zzz-height-${String(index + 1).padStart(2, "0")}`;
    return { type: "skill" as const, name, path: `ephemeral/skills/${name}`, bundle: "pi-web-access", description: "height fixture child" };
  });
  for (const resource of extraResources) {
    await mkdir(join(packageRoot, resource.path), { recursive: true });
    await writeFile(join(packageRoot, resource.path, "SKILL.md"), `# ${resource.name}\n`);
  }
  await writeFile(resourcesPath, JSON.stringify({ ...catalog, resources: [...catalog.resources, ...extraResources] }));
}

function testTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as never;
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
}

function lineContaining(output: string, text: string): string {
  return output.split("\n").find((line) => line.includes(text)) ?? "";
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function semanticTokenIndex(line: string, token: string): number {
  return stripAnsi(line).indexOf(token);
}

function normalizeTableItemGutter(line: string): string {
  return stripAnsi(line).replace(/^→ /, "  ");
}

function tableItemLine(output: string, text: string): string {
  return output
    .split("\n")
    .map(normalizeTableItemGutter)
    .find((line) => line.includes(text) && /(?:^|\s)(?:bundle|extension|skill|prompt)(?:\s|$)/.test(line)) ?? "";
}

initTheme("dark");

describe("resource manager view model", () => {
  it("renders a root/detail bundle tree with mixed-scope warnings", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "extension", name: "pi-web-access" }));
    const catalog = await loadCatalogSet(ctx.packageRoot);
    const globalState = await readState(globalStatePath(ctx.agentDir));
    const projectState = { version: 1 as const, activations: [{ type: "skill" as const, name: "librarian", target: ".pi/skills/librarian" }] };

    const roots = buildResourceManagerViewModel({ catalog, globalState, projectState, selectedScope: "project", details: false, pending: [] });

    expect(roots.rows.map((row) => row.identity)).toEqual(["bundle:pi-intercom", "bundle:pi-web-access", "skill:grill-me"]);
    expect(roots.rows.find((row) => row.identity === "bundle:pi-web-access")).toMatchObject({ type: "bundle", use: "project*", action: "enable" });
    expect(roots.rows.find((row) => row.identity === "bundle:pi-web-access")?.warnings.join("\n")).toMatch(/mixed global\/project/);
    expect(roots.rows.some((row) => row.identity === "skill:librarian")).toBe(false);

    const details = buildResourceManagerViewModel({ catalog, globalState, projectState, selectedScope: "project", details: true, pending: [] });
    expect(details.rows.map((row) => row.identity)).toContain("skill:librarian");
    expect(details.rows.find((row) => row.identity === "skill:librarian")).toMatchObject({ depth: 1, action: "disable", use: "project" });
  });

  it("shows pending global promotion side effects before apply", async () => {
    const ctx = await context();
    const catalog = await loadCatalogSet(ctx.packageRoot);
    const globalState = { version: 1 as const, activations: [] };
    const projectState = { version: 1 as const, activations: [{ type: "skill" as const, name: "grill-me", target: ".pi/skills/grill-me" }] };
    const pending: PendingResourceToggle[] = [{ type: "skill", name: "grill-me", scope: "global", enabled: true }];

    const vm = buildResourceManagerViewModel({ catalog, globalState, projectState, selectedScope: "global", details: false, pending });

    const local = vm.rows.find((row) => row.identity === "skill:grill-me");
    expect(local).toMatchObject({ use: "global", action: "disable", pending: true, pendingEnabled: true, active: true, usageCount: 2 });
    expect(vm.warnings.map((warning) => warning.code)).toContain("pending_promotion");
    expect(vm.sideEffects).toContainEqual(expect.objectContaining({ action: "prune_project_activation", identity: "skill:grill-me" }));
  });

  it("applies pending changes by recomputing planner decisions", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "skill", name: "grill-me" }));

    const result = await applyPendingResourceChanges(ctx, [{ type: "skill", name: "grill-me", scope: "global", enabled: true }]);

    expect(result.plan.ok).toBe(true);
    expect(result.plan.changes.some((change) => change.action === "prune_project_activation")).toBe(true);
    await expect(readState(globalStatePath(ctx.agentDir))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "grill-me", target: "skills/grill-me" }] });
    await expect(readState(projectStatePath(ctx.projectRoot))).resolves.toEqual({ version: 1, activations: [] });
  });
});

describe("resource manager component", () => {
  it("defaults to root rows only and toggles detail mode with aligned hierarchy columns", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("pi-web-access"));
    const rootOutput = component.render(100).join("\n");
    expect(rootOutput).toContain("Scope: project (fixed at launch) • Details: off • Search: (none)");
    expect(rootOutput).toContain("bundle");
    expect(rootOutput).toContain("grill-me");
    expect(rootOutput).not.toContain("Categories:");
    expect(rootOutput).not.toMatch(/\s{2}skill\s+librarian/);

    component.handleInput("d");
    const detailOutput = component.render(100).join("\n");
    expect(detailOutput).toContain("Details: on");
    expect(detailOutput).toMatch(/\s{2}extension\s+pi-web-access/);
    expect(detailOutput).toMatch(/\s{2}skill\s+librarian/);
    expect(lineContaining(detailOutput, "pi-web-access").indexOf("Name")).toBe(-1);
    const bundleLine = detailOutput.split("\n").find((line) => line.includes("bundle") && line.includes("pi-web-access")) ?? "";
    const childLine = lineContaining(detailOutput, "librarian");
    expect(bundleLine.indexOf("pi-web-access")).toBe(childLine.indexOf("librarian"));
  });

  it("aligns title, status, header, and table rows with SelectList gutter accounted for", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    let output = component.render(100).join("\n");
    const expectedStart = semanticTokenIndex(lineContaining(output, "Pi Ephemeral Resource Manager"), "Pi Ephemeral Resource Manager");
    expect(expectedStart).toBeGreaterThanOrEqual(0);
    expect(semanticTokenIndex(lineContaining(output, "Scope: project"), "Scope: project")).toBe(expectedStart);
    expect(semanticTokenIndex(lineContaining(output, "Use /pi-ephemeral --global"), "Managing")).toBe(expectedStart);
    let header = stripAnsi(lineContaining(output, "Pending"));
    expect(semanticTokenIndex(header, "Use")).toBe(expectedStart);
    expect(semanticTokenIndex(tableItemLine(output, "grill-me"), "skill")).toBe(semanticTokenIndex(header, "Type"));
    expect(semanticTokenIndex(tableItemLine(output, "grill-me"), "grill-me")).toBe(semanticTokenIndex(header, "Name"));

    component.handleInput("d");
    output = component.render(100).join("\n");
    header = stripAnsi(lineContaining(output, "Pending"));
    const bundleLine = tableItemLine(output, "pi-web-access");
    let childLine = tableItemLine(output, "librarian");
    expect(semanticTokenIndex(bundleLine, "pi-web-access")).toBe(semanticTokenIndex(header, "Name"));
    expect(semanticTokenIndex(childLine, "librarian")).toBe(semanticTokenIndex(header, "Name"));
    expect(semanticTokenIndex(childLine, "skill")).toBe(semanticTokenIndex(header, "Type") + 2);

    component.handleInput("/");
    for (const char of "librarian") component.handleInput(char);
    output = component.render(100).join("\n");
    expect(semanticTokenIndex(lineContaining(output, "Pi Ephemeral Resource Manager"), "Pi Ephemeral Resource Manager")).toBe(expectedStart);
    expect(semanticTokenIndex(lineContaining(output, "Scope: project"), "Scope: project")).toBe(expectedStart);
    header = stripAnsi(lineContaining(output, "Pending"));
    childLine = tableItemLine(output, "librarian");
    expect(semanticTokenIndex(header, "Use")).toBe(expectedStart);
    expect(semanticTokenIndex(childLine, "librarian")).toBe(semanticTokenIndex(header, "Name"));
  });

  it("shows more than the old 12-row cap in detail mode", async () => {
    const ctx = await context();
    await addHeightFixtureResources(ctx.packageRoot);
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(120).join("\n")).toContain("pi-web-access"));
    component.handleInput("d");

    const output = component.render(120).join("\n");
    expect(output).toContain("Details: on");
    expect(output).toContain("zzz-height-08");
  });

  it("cascades bundle enable toggles and applies both editable child activations", async () => {
    const ctx = await context();
    const done = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done, notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("pi-intercom"));
    component.handleInput(" ");

    await waitForExpectation(() => {
      const output = component.render(100).join("\n");
      expect(output).toContain("extension:pi-intercom");
      expect(output).toContain("skill:pi-intercom");
    });
    component.handleInput("\r");

    await waitForExpectation(() => expect(done).toHaveBeenCalledWith("applied"));
    await expect(readState(projectStatePath(ctx.projectRoot))).resolves.toEqual({ version: 1, activations: [
      { type: "extension", name: "pi-intercom", target: ".pi/extensions/pi-intercom" },
      { type: "skill", name: "pi-intercom", target: ".pi/skills/pi-intercom" },
    ] });
  });

  it("detail-mode child toggle affects only the selected child", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("pi-web-access"));
    component.handleInput("d");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput(" ");

    await waitForExpectation(() => {
      const output = component.render(100).join("\n");
      expect(output).toContain("skill:librarian");
      expect(output).not.toContain("extension:pi-web-access");
    });
  });

  it("bundle disable cascades only mutable active children in current scope and not unrelated roots", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "extension", name: "pi-intercom" }));
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "skill", name: "pi-intercom" }));
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "skill", name: "grill-me" }));
    const done = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done, notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toMatch(/pi-intercom\s+disable/));
    component.handleInput(" ");
    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("disable"));
    component.handleInput("\r");

    await waitForExpectation(() => expect(done).toHaveBeenCalledWith("applied"));
    await expect(readState(projectStatePath(ctx.projectRoot))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "grill-me", target: ".pi/skills/grill-me" }] });
  });

  it("bundle enable in project scope skips globally active and always-on children", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "extension", name: "pi-web-access" }));
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("pi-web-access"));
    component.handleInput("j");
    component.handleInput(" ");

    await waitForExpectation(() => {
      const output = component.render(100).join("\n");
      expect(output).toContain("skill:librarian");
      expect(output).toContain("skill:pi-web-access");
      expect(output).not.toContain("extension:pi-web-access");
      expect(output).not.toContain("skill:using-superpowers");
    });
  });

  it("blank-action bundle notifies and creates no pending changes", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "extension", name: "pi-web-access" }));
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "librarian" }));
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "skill", name: "pi-web-access" }));
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "prompt", name: "web-research" }));
    const notify = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify, requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toMatch(/pi-web-access\s*$/m));
    component.handleInput("j");
    component.handleInput(" ");

    expect(notify).toHaveBeenCalledWith("No editable resources in bundle pi-web-access for project scope", "warning");
    expect(component.render(100).join("\n")).toContain("No pending changes.");
  });

  it("renders mixed-scope warnings in default and detail modes", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "global", type: "extension", name: "pi-web-access" }));
    await mkdir(join(ctx.projectRoot, ".pi"), { recursive: true });
    await writeFile(projectStatePath(ctx.projectRoot), JSON.stringify({ version: 1, activations: [{ type: "skill", name: "librarian", target: ".pi/skills/librarian" }] }));
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("mixed global/project"));
    component.handleInput("d");
    expect(component.render(100).join("\n")).toContain("mixed global/project");
  });

  it("searches hierarchically without SelectList double filtering", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    for (const char of "librarian") component.handleInput(char);
    component.handleInput("\r");

    let output = component.render(100).join("\n");
    expect(output).toContain("pi-web-access");
    expect(output).toMatch(/\s{2}skill\s+librarian/);
    expect(output).not.toContain("pi-intercom");
    expect(output).not.toContain("grill-me");
    expect(output).not.toMatch(/\s{2}extension\s+pi-web-access/);
    expect(output).not.toMatch(/\s{2}skill\s+pi-web-access/);
    expect(output).not.toMatch(/\s{2}prompt\s+web-research/);
    expect(output).not.toContain("No matching commands");

    component.handleInput("d");
    output = component.render(100).join("\n");
    expect(output).toContain("pi-web-access");
    expect(output).toMatch(/\s{2}skill\s+librarian/);
    expect(output).not.toMatch(/\s{2}extension\s+pi-web-access/);
    expect(output).not.toMatch(/\s{2}skill\s+pi-web-access/);
    expect(output).not.toMatch(/\s{2}prompt\s+web-research/);

    component.handleInput("/");
    for (let i = 0; i < "librarian".length; i++) component.handleInput("\x7f");
    component.handleInput("/");
    for (const char of "browser") component.handleInput(char);
    component.handleInput("\r");
    output = component.render(100).join("\n");
    expect(output).toContain("pi-web-access");
    expect(output).toMatch(/\s{2}extension\s+pi-web-access/);
    expect(output).not.toContain("No matching commands");
  });

  it("keeps project TUI scope fixed and applies toggles only to project state", async () => {
    const ctx = await context();
    const done = vi.fn();
    const notify = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done, notify, requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => {
      const output = component.render(100).join("\n");
      expect(output).toContain("Scope: project (fixed at launch)");
      expect(output).toContain("Use");
      expect(output).toContain("Type");
      expect(output).toContain("Name");
      expect(output).toContain("Action");
      expect(output).toContain("grill-me");
    });
    expect(component.render(100).join("\n")).toContain("Use /pi-ephemeral --global to manage global scope.");

    component.handleInput("j");
    component.handleInput("j");
    component.handleInput(" ");
    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("change:"));
    component.handleInput("\r");

    await waitForExpectation(() => expect(done).toHaveBeenCalledWith("applied"));
    await expect(readState(projectStatePath(ctx.projectRoot))).resolves.toEqual({ version: 1, activations: [{ type: "skill", name: "grill-me", target: ".pi/skills/grill-me" }] });
    await expect(readFile(globalStatePath(ctx.agentDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders readable resource table columns at 100 columns without truncating common type or name values", async () => {
    const ctx = await context();
    await applyPlan(await planEnable({ ...ctx, scope: "project", type: "skill", name: "grill-me" }));
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => {
      const output = component.render(100).join("\n");
      expect(output).toContain("Use");
      expect(output).toContain("Type");
      expect(output).toContain("Name");
      expect(output).toContain("Action");
      expect(output).toContain("Pending");
      expect(output).toContain("pi-web-access");
      expect(output).toMatch(/project\s+skill\s+grill-me\s+disable/);
      expect(output).not.toContain("pi-web-acce…");
    });

    component.handleInput("d");
    await waitForExpectation(() => expect(component.render(100).join("\n")).toMatch(/\s{2}extension\s+pi-web-access/));
  });

  it("searches by resource name substring without a second SelectList prefix filter", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    for (const char of "rill") component.handleInput(char);
    component.handleInput("\r");

    const output = component.render(100).join("\n");
    expect(output).toContain("grill-me");
    expect(output).not.toContain("No matching commands");
  });

  it("searches by description without SelectList removing matching rows", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    for (const char of "critique") component.handleInput(char);
    component.handleInput("\r");

    const output = component.render(100).join("\n");
    expect(output).toContain("grill-me");
    expect(output).not.toContain("unbundled critique");
    expect(output).not.toContain("No matching commands");
  });

  it("searches by identity and type through the shared resource search helper", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    for (const char of "skill:librarian") component.handleInput(char);
    component.handleInput("\r");

    let output = component.render(100).join("\n");
    expect(output).toContain("pi-web-access");
    expect(output).toMatch(/\s{2}skill\s+librarian/);
    expect(output).not.toMatch(/\s{2}extension\s+pi-web-access/);
    expect(output).not.toMatch(/\s{2}prompt\s+web-research/);

    component.handleInput("/");
    for (let i = 0; i < "skill:librarian".length; i++) component.handleInput("\x7f");
    component.handleInput("/");
    for (const char of "prompt") component.handleInput(char);
    component.handleInput("\r");

    output = component.render(100).join("\n");
    expect(output).toContain("pi-web-access");
    expect(output).toMatch(/\s{2}prompt\s+web-research/);
    expect(output).not.toMatch(/\s{2}skill\s+librarian/);
    expect(output).not.toContain("grill-me");
  });

  it("cancels from direct component input on Escape", async () => {
    const ctx = await context();
    const done = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done, notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("\x1b");

    expect(done).toHaveBeenCalledWith("cancelled");
  });

  it("navigates with Kitty protocol down arrow input", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("\x1b[1;1B");
    component.handleInput("\x1b[1;1B");
    component.handleInput(" ");

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("change:"));
    expect(component.render(100).join("\n")).toContain("enable");
  });

  it("navigates with Kitty protocol up arrow input", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("\x1b[1;1B");
    component.handleInput("\x1b[1;1B");
    component.handleInput("\x1b[1;1A");
    component.handleInput(" ");

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("change:"));
    expect(component.render(100).join("\n")).toContain("enable");
  });

  it("cancels from normal mode on Kitty protocol Escape input", async () => {
    const ctx = await context();
    const done = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done, notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("\x1b[27u");

    expect(done).toHaveBeenCalledWith("cancelled");
  });

  it("cancels from search mode on Kitty protocol Escape input", async () => {
    const ctx = await context();
    const done = vi.fn();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done, notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    component.handleInput("g");
    component.handleInput("\x1b[27;1u");

    expect(done).toHaveBeenCalledWith("cancelled");
  });

  it("exits empty search after Backspace so navigation resumes", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    component.handleInput("g");
    component.handleInput("\x7f");

    const afterBackspace = component.render(100).join("\n");
    expect(afterBackspace).toContain("Search: (none)");
    expect(afterBackspace).not.toContain("Search: /");

    component.handleInput("j");
    component.handleInput("j");
    component.handleInput(" ");

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("change:"));
    expect(component.render(100).join("\n")).toContain("enable");
  });

  it("exits empty search after Kitty CSI-u Backspace so navigation resumes", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("/");
    component.handleInput("g");
    component.handleInput("\x1b[127u");

    const afterBackspace = component.render(100).join("\n");
    expect(afterBackspace).toContain("Search: (none)");
    expect(afterBackspace).not.toContain("Search: /");

    component.handleInput("j");
    component.handleInput("j");
    component.handleInput(" ");

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("change:"));
    expect(component.render(100).join("\n")).toContain("enable");
  });

  it("accepts Kitty protocol printable slash and search text", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => expect(component.render(100).join("\n")).toContain("grill-me"));
    component.handleInput("\x1b[47u");
    component.handleInput("\x1b[114u");
    component.handleInput("\x1b[105u");
    component.handleInput("\x1b[108u");
    component.handleInput("\x1b[108u");

    const output = component.render(100).join("\n");
    expect(output).toContain("Search: /rill");
    expect(output).toContain("grill-me");
    expect(output).not.toContain("No matching commands");
  });

  it("toggles detail mode with d instead of category tabs", async () => {
    const ctx = await context();
    const component = new ResourceManagerComponent({ ...ctx, initialScope: "project", done: vi.fn(), notify: vi.fn(), requestRender: vi.fn(), theme: testTheme(), keybindings: getKeybindings() });

    await waitForExpectation(() => {
      const output = component.render(100).join("\n");
      expect(output).toContain("Details: off");
      expect(output).not.toContain("Categories:");
    });
    component.handleInput("d");

    await waitForExpectation(() => expect(component.render(100).join("\n")).toMatch(/\s{2}skill\s+librarian/));
    const output = component.render(100).join("\n");
    expect(output).toContain("Details: on");
  });
});
