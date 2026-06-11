import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";

async function tempDir(prefix = "cli"): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-ephemeral-${prefix}-`));
}

async function fixture() {
  const root = await tempDir();
  const packageRoot = join(root, "pkg");
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  await mkdir(join(packageRoot, "extensions", "pi-ephemeral"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "extensions", "pi-web-access"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "brainstorming"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "using-superpowers"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "librarian"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "skills", "grill-me"), { recursive: true });
  await mkdir(join(packageRoot, "ephemeral", "prompts"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(packageRoot, "resources.json"), JSON.stringify({ version: 1, resources: [
    { type: "extension", name: "pi-ephemeral", path: "extensions/pi-ephemeral" },
  ] }));
  await writeFile(join(packageRoot, "ephemeral", "resources.json"), JSON.stringify({ version: 1, resources: [
    { type: "extension", name: "pi-web-access", path: "ephemeral/extensions/pi-web-access", bundle: "pi-web-access" },
    { type: "skill", name: "brainstorming", path: "ephemeral/skills/brainstorming", description: "brainstorming details" },
    { type: "skill", name: "using-superpowers", path: "ephemeral/skills/using-superpowers" },
    { type: "skill", name: "librarian", path: "ephemeral/skills/librarian", bundle: "pi-web-access", description: "Evidence-backed open-source library research" },
    { type: "skill", name: "grill-me", path: "ephemeral/skills/grill-me", description: "unbundled critique" },
    { type: "prompt", name: "cleanup", path: "ephemeral/prompts/cleanup.md" },
    { type: "prompt", name: "web-research", path: "ephemeral/prompts/web-research.md", bundle: "pi-web-access" },
  ] }));
  await writeFile(join(packageRoot, "extensions", "pi-ephemeral", "index.ts"), "export {};\n");
  await writeFile(join(packageRoot, "ephemeral", "extensions", "pi-web-access", "index.ts"), "export {};\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "brainstorming", "SKILL.md"), "# Brainstorming\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "using-superpowers", "SKILL.md"), "# Using superpowers\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "librarian", "SKILL.md"), "# Librarian\n");
  await writeFile(join(packageRoot, "ephemeral", "skills", "grill-me", "SKILL.md"), "# Grill me\n");
  await writeFile(join(packageRoot, "ephemeral", "prompts", "cleanup.md"), "cleanup\n");
  await writeFile(join(packageRoot, "ephemeral", "prompts", "web-research.md"), "web research\n");
  return { packageRoot, agentDir, projectRoot };
}

async function invoke(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("CLI", () => {
  it("prints help with exit 0 and rejects invalid commands", async () => {
    await expect(invoke(["--help"])).resolves.toMatchObject({ exitCode: 0 });
    const invalid = await invoke(["nope"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toMatch(/Unknown command|Usage/);

    const update = await invoke(["update"]);
    expect(update.exitCode).toBe(2);
    expect(update.stderr).toMatch(/Unknown command update/);
  });

  it("lists resources and reports status as deterministic JSON", async () => {
    const ctx = await fixture();
    const listed = await invoke(["list", "--json", "--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot]);
    expect(listed.exitCode).toBe(0);
    const listedJson = JSON.parse(listed.stdout);
    expect(listedJson.command).toBe("list");
    expect(listedJson.resources).toEqual(expect.arrayContaining([expect.objectContaining({ identity: "skill:brainstorming", active: { global: false, project: false } })]));
    expect(listedJson.resources.find((resource: { identity: string }) => resource.identity === "skill:librarian")).not.toHaveProperty("bundle");

    const status = await invoke(["status", "--json", "--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ command: "status", global: [], project: [] });
  });

  it("renders list as an aligned bundle tree", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    const result = await invoke(["list", "--width", "100", ...base]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Use");
    expect(result.stdout).toContain("Type");
    expect(result.stdout).toContain("Name");
    expect(result.stdout).not.toContain("Action");
    expect(result.stdout).toMatch(/^\s*bundle\s+pi-web-access\s*$/m);
    expect(result.stdout).toMatch(/^\s+extension\s+pi-web-access\s*$/m);
    expect(result.stdout).toMatch(/^\s+skill\s+librarian\s*$/m);
    expect(result.stdout).toMatch(/^\s+prompt\s+web-research\s*$/m);
    expect(result.stdout).toMatch(/^\s*skill\s+grill-me\s*$/m);
    expect(result.stdout).not.toMatch(/^.*\s+(enable|disable)\s*$/m);
    expect(result.stdout).not.toContain("brainstorming details");

    const lines = result.stdout.split("\n");
    const header = lines.find((line) => line.includes("Use") && line.includes("Type") && line.includes("Name"))!;
    const nameIndex = header.indexOf("Name");
    const bundleLine = lines.find((line) => line.includes("bundle") && line.includes("pi-web-access"))!;
    const childLine = lines.find((line) => line.includes("skill") && line.includes("librarian"))!;
    expect(bundleLine.indexOf("pi-web-access")).toBe(nameIndex);
    expect(childLine.indexOf("librarian")).toBe(nameIndex);
  });

  it("filters human and JSON list output with shared bundle grouping semantics", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];

    const child = await invoke(["list", "--filter", "librarian", "--width", "100", ...base]);
    expect(child.exitCode).toBe(0);
    expect(child.stdout).toContain("Resources:");
    expect(child.stdout).toMatch(/^\s*bundle\s+pi-web-access\s*$/m);
    expect(child.stdout).toMatch(/^\s+skill\s+librarian\s*$/m);
    expect(child.stdout).not.toContain("grill-me");
    expect(child.stdout).not.toContain("web-research");

    const bundle = await invoke(["list", "--filter", "pi-web-access", "--width", "100", ...base]);
    expect(bundle.exitCode).toBe(0);
    expect(bundle.stdout).toMatch(/^\s*bundle\s+pi-web-access\s*$/m);
    expect(bundle.stdout).toMatch(/^\s+extension\s+pi-web-access\s*$/m);
    expect(bundle.stdout).toMatch(/^\s+skill\s+librarian\s*$/m);
    expect(bundle.stdout).toMatch(/^\s+prompt\s+web-research\s*$/m);

    const description = await invoke(["list", "--filter", "critique", "--width", "100", ...base]);
    expect(description.exitCode).toBe(0);
    expect(description.stdout).toMatch(/^\s*skill\s+grill-me\s*$/m);
    expect(description.stdout).not.toContain("unbundled critique");

    const none = await invoke(["list", "--filter", "nope", "--width", "100", ...base]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("Resources:\nNo matching resources.\n");

    const json = await invoke(["list", "--filter", "librarian", "--json", ...base]);
    expect(json.exitCode).toBe(0);
    const output = JSON.parse(json.stdout);
    expect(output).toMatchObject({ command: "list", filter: "librarian", packageRoot: ctx.packageRoot, projectRoot: ctx.projectRoot, agentDir: ctx.agentDir });
    expect(output.problems).toEqual(expect.any(Array));
    expect(output.resources.map((resource: { identity: string }) => resource.identity)).toEqual(["skill:librarian"]);
    expect(output.resources[0]).not.toHaveProperty("bundle");
  });

  it("renders exact and query resource info with compatible JSON shapes", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];

    const exact = await invoke(["info", "skill", "librarian", ...base]);
    expect(exact.exitCode).toBe(0);
    expect(exact.stdout).toContain("Bundle      : pi-web-access");
    expect(exact.stdout).toContain("Type        : skill");
    expect(exact.stdout).toContain("Name        : librarian");
    expect(exact.stdout).toContain("Source      : ephemeral/skills/librarian");
    expect(exact.stdout).toContain("Target      : skills/librarian");

    const exactJson = await invoke(["info", "skill", "librarian", "--json", ...base]);
    expect(exactJson.exitCode).toBe(0);
    const exactOutput = JSON.parse(exactJson.stdout);
    expect(exactOutput).toMatchObject({ command: "info", resource: { bundle: "pi-web-access", type: "skill", name: "librarian" } });
    expect(exactOutput).not.toHaveProperty("resources");

    const query = await invoke(["info", "librarian", ...base]);
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain("Bundle      : pi-web-access");
    expect(query.stdout).toContain("Type        : skill");
    expect(query.stdout).toContain("Name        : librarian");
    expect(query.stdout).not.toContain("Resources  :");

    const bundleQuery = await invoke(["info", "pi-web-access", ...base]);
    expect(bundleQuery.exitCode).toBe(0);
    expect(bundleQuery.stdout).toContain("Bundle      : pi-web-access");
    expect(bundleQuery.stdout).toContain("Type        : extension");
    expect(bundleQuery.stdout).toContain("Type        : skill");
    expect(bundleQuery.stdout).toContain("Type        : prompt");
    expect(bundleQuery.stdout).not.toContain("Resources  :");

    const queryJson = await invoke(["info", "librarian", "--json", ...base]);
    expect(queryJson.exitCode).toBe(0);
    const queryOutput = JSON.parse(queryJson.stdout);
    expect(queryOutput).toMatchObject({ command: "info", query: "librarian", resources: [{ type: "skill", name: "librarian", bundle: "pi-web-access" }] });
    expect(queryOutput).not.toHaveProperty("resource");

    const noMatch = await invoke(["info", "nope", ...base]);
    expect(noMatch.exitCode).toBe(1);
    expect(noMatch.stderr).toContain("No resources match");
  });

  it("renders bundle-only query info as a compact bundle block", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    const result = await invoke(["info", "bundle:pi-web-access", ...base]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bundle      : pi-web-access");
    expect(result.stdout).toContain("Use         :");
    expect(result.stdout).toContain("Action      : enable");
    expect(result.stdout).toContain("Resources   : extension:pi-web-access, skill:librarian, prompt:web-research");
    expect(result.stdout).toContain("Warnings    : none");
    expect(result.stdout).not.toContain("Type        : extension");
  });

  it("renders active status as an aligned bundle tree", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "extension", "pi-web-access", "--global", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await expect(invoke(["enable", "skill", "librarian", "--global", ...base])).resolves.toMatchObject({ exitCode: 0 });

    const result = await invoke(["status", "--width", "100", ...base]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Target");
    expect(result.stdout).toMatch(/^global\*\s+bundle\s+pi-web-access\s+/m);
    expect(result.stdout).toMatch(/^global\s+extension\s+pi-web-access\s+/m);
    expect(result.stdout).toMatch(/^global\s+skill\s+librarian\s+/m);
    expect(result.stdout).not.toContain("web-research");

    const lines = result.stdout.split("\n");
    const header = lines.find((line) => line.includes("Use") && line.includes("Type") && line.includes("Name") && line.includes("Target"))!;
    const nameIndex = header.indexOf("Name");
    const targetIndex = header.indexOf("Target");
    const bundleLine = lines.find((line) => line.includes("bundle") && line.includes("pi-web-access"))!;
    const extensionLine = lines.find((line) => line.includes("extension") && line.includes("pi-web-access"))!;
    const skillLine = lines.find((line) => line.includes("skill") && line.includes("librarian"))!;
    expect(bundleLine.indexOf("pi-web-access")).toBe(nameIndex);
    expect(extensionLine.indexOf("pi-web-access")).toBe(nameIndex);
    expect(skillLine.indexOf("librarian")).toBe(nameIndex);
    expect(bundleLine.indexOf("extensions/pi-web-access")).toBe(targetIndex);
    expect(extensionLine.indexOf("extensions/pi-web-access")).toBe(targetIndex);
    expect(skillLine.indexOf("skills/librarian")).toBe(targetIndex);
  });

  it("warns when bundle children mix global and project activations", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "skill", "librarian", "--global", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await expect(invoke(["enable", "prompt", "web-research", "--project", ...base])).resolves.toMatchObject({ exitCode: 0 });
    const warning = "bundle pi-web-access has mixed global/project child activations; extract independently managed resources or normalize scopes";

    const listed = await invoke(["list", "--width", "100", ...base]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(warning);

    const status = await invoke(["status", "--width", "100", ...base]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(warning);
  });

  it("includes bundle in human and JSON resource info", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];

    const info = await invoke(["info", "skill", "librarian", ...base]);
    expect(info.exitCode).toBe(0);
    expect(info.stdout).toContain("Bundle      : pi-web-access");
    expect(info.stdout).toContain("Type        : skill");
    expect(info.stdout).toContain("Name        : librarian");

    const infoJson = await invoke(["info", "skill", "librarian", "--json", ...base]);
    expect(infoJson.exitCode).toBe(0);
    expect(JSON.parse(infoJson.stdout)).toMatchObject({ resource: { bundle: "pi-web-access", type: "skill", name: "librarian" } });
  });

  it("preserves legacy status JSON ordering while human status uses display order", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "skill", "using-superpowers", "--project", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await expect(invoke(["enable", "prompt", "cleanup", "--project", ...base])).resolves.toMatchObject({ exitCode: 0 });

    const jsonStatus = await invoke(["status", "--json", ...base]);
    expect(jsonStatus.exitCode).toBe(0);
    expect(JSON.parse(jsonStatus.stdout).project.map((record: { type: string; name: string }) => `${record.type}:${record.name}`)).toEqual(["prompt:cleanup", "skill:using-superpowers"]);

    const humanStatus = await invoke(["status", "--width", "100", ...base]);
    expect(humanStatus.exitCode).toBe(0);
    expect(humanStatus.stdout.indexOf("skill")).toBeLessThan(humanStatus.stdout.indexOf("prompt"));
  });

  it("prints readable human list, status, and info output", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "skill", "using-superpowers", "--global", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await expect(invoke(["enable", "prompt", "cleanup", "--project", ...base])).resolves.toMatchObject({ exitCode: 0 });

    const listed = await invoke(["list", "--width", "100", ...base]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Use");
    expect(listed.stdout).toContain("Type");
    expect(listed.stdout).toContain("Name");
    expect(listed.stdout).not.toContain("Action");
    expect(listed.stdout).toContain("always");
    expect(listed.stdout).toContain("extension");
    expect(listed.stdout).toContain("pi-ephemeral");
    expect(listed.stdout).toContain("brainstorming");
    expect(listed.stdout).not.toMatch(/^.*\s+(enable|disable)\s*$/m);
    expect(listed.stdout).not.toContain("inactive");
    expect(listed.stdout).not.toContain("brainstorming details");
    expect(listed.stdout).not.toContain("ephemeral/skills/brainstorming");
    expect(listed.stdout.indexOf("extension")).toBeLessThan(listed.stdout.indexOf("skill"));
    expect(listed.stdout.indexOf("skill")).toBeLessThan(listed.stdout.indexOf("prompt"));

    const status = await invoke(["status", "-w", "100", ...base]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Use");
    expect(status.stdout).toContain("Type");
    expect(status.stdout).toContain("Name");
    expect(status.stdout).toContain("Target");
    expect(status.stdout).toContain("skills/using-superpowers");
    expect(status.stdout).toContain("prompts/cleanup.md");
    expect(status.stdout).not.toContain("brainstorming");

    const info = await invoke(["info", "skill", "brainstorming", ...base]);
    expect(info.exitCode).toBe(0);
    expect(info.stdout).toContain("Type        : skill");
    expect(info.stdout).toContain("Name        : brainstorming");
    expect(info.stdout).toContain("Use         :");
    expect(info.stdout).toContain("Action      : enable");
    expect(info.stdout).toContain("Source      : ephemeral/skills/brainstorming");
    expect(info.stdout).toContain("Target      : skills/brainstorming");
    expect(info.stdout).toContain("Description : brainstorming details");
  });

  it("applies enable, repair, and disable with reload hints", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    const enabled = await invoke(["enable", "skill", "brainstorming", "--global", ...base]);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.stdout).toMatch(/Reload recommended/);
    await expect(readFile(join(ctx.agentDir, "skills", "brainstorming", "SKILL.md"), "utf8")).resolves.toContain("Brainstorming");

    const repaired = await invoke(["repair", "skill", "brainstorming", "--global", "--json", ...base]);
    expect(repaired.exitCode).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ command: "repair", plan: { ok: true }, applied: { applied: [] } });

    const disabled = await invoke(["disable", "skill", "brainstorming", "--global", ...base]);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stdout).toMatch(/Reload recommended/);
  });

  it("includes malformed state paths in errors", async () => {
    const ctx = await fixture();
    await writeFile(join(ctx.agentDir, "pi-ephemeral-global.json"), "{ nope");
    const result = await invoke(["status", "--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(join(ctx.agentDir, "pi-ephemeral-global.json"));
  });

  it("scopes repair --global without reading malformed indexed project state and reports activation evidence", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "skill", "brainstorming", "--global", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await mkdir(join(ctx.projectRoot, ".pi"), { recursive: true });
    await writeFile(join(ctx.projectRoot, ".pi", "pi-ephemeral.json"), "{ nope");
    await writeFile(join(ctx.agentDir, "pi-ephemeral-projects.json"), JSON.stringify({ version: 1, projects: [ctx.projectRoot] }, null, 2) + "\n");

    const result = await invoke(["repair", "--global", "--json", ...base]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan).toMatchObject({ ok: true, scope: "global", changes: [] });
    expect(output.plan.activations).toEqual([
      {
        scope: "global",
        statePath: join(ctx.agentDir, "pi-ephemeral-global.json"),
        activations: [{ type: "skill", name: "brainstorming", target: "skills/brainstorming" }],
      },
    ]);
  });

  it("scopes repair --project without reading unrelated malformed global state", async () => {
    const ctx = await fixture();
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "skill", "brainstorming", "--project", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(ctx.agentDir, "pi-ephemeral-global.json"), "{ nope");

    const result = await invoke(["repair", "--project", "--json", ...base]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan).toMatchObject({ ok: true, scope: "project", changes: [] });
    expect(output.plan.activations).toEqual([
      {
        scope: "project",
        statePath: join(ctx.projectRoot, ".pi", "pi-ephemeral.json"),
        projectRoot: ctx.projectRoot,
        activations: [{ type: "skill", name: "brainstorming", target: ".pi/skills/brainstorming" }],
      },
    ]);
  });

  it("runs default repair against global and current project only", async () => {
    const ctx = await fixture();
    const project2 = join(ctx.projectRoot, "sibling");
    await mkdir(join(project2, ".pi"), { recursive: true });
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir, "--cwd", ctx.projectRoot];
    await expect(invoke(["enable", "skill", "brainstorming", "--project", ...base])).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(project2, ".pi", "pi-ephemeral.json"), "{ nope");
    await writeFile(join(ctx.agentDir, "pi-ephemeral-projects.json"), JSON.stringify({ version: 1, projects: [ctx.projectRoot, project2] }, null, 2) + "\n");

    const result = await invoke(["repair", "--json", ...base]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan).toMatchObject({ ok: true, scope: "mixed" });
    expect(output.plan.activations).toEqual([
      {
        scope: "global",
        statePath: join(ctx.agentDir, "pi-ephemeral-global.json"),
        activations: [],
      },
      {
        scope: "project",
        statePath: join(ctx.projectRoot, ".pi", "pi-ephemeral.json"),
        projectRoot: ctx.projectRoot,
        activations: [{ type: "skill", name: "brainstorming", target: ".pi/skills/brainstorming" }],
      },
    ]);
  });

  it("runs targeted repair --all against indexed projects", async () => {
    const ctx = await fixture();
    const project2 = join(ctx.projectRoot, "sibling");
    await mkdir(project2, { recursive: true });
    const base = ["--package", ctx.packageRoot, "--agent-dir", ctx.agentDir];
    await expect(invoke(["enable", "skill", "brainstorming", "--project", "--cwd", project2, ...base])).resolves.toMatchObject({ exitCode: 0 });

    const result = await invoke(["repair", "skill", "brainstorming", "--all", "--json", "--cwd", ctx.projectRoot, ...base]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan).toMatchObject({ ok: true, scope: "mixed" });
    expect(output.plan.activations).toEqual([
      {
        scope: "global",
        statePath: join(ctx.agentDir, "pi-ephemeral-global.json"),
        activations: [],
      },
      {
        scope: "project",
        statePath: join(project2, ".pi", "pi-ephemeral.json"),
        projectRoot: project2,
        activations: [{ type: "skill", name: "brainstorming", target: ".pi/skills/brainstorming" }],
      },
    ]);
  });
});
