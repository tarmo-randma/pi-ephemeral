import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalogSet } from "../../src/core/catalog.js";
import { deriveTargetPath } from "../../src/core/targets.js";
import type { ResourceRecord } from "../../src/core/types.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-eph-targets-"));
}

async function expectTarget(root: string, record: ResourceRecord, targetPath: string): Promise<void> {
  await expect(deriveTargetPath(root, record)).resolves.toEqual(targetPath);
}

describe("deriveTargetPath", () => {
  it("maps skill directory containing SKILL.md from directory basename", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "actual"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "actual", "SKILL.md"), "# skill");
    await expectTarget(root, { type: "skill", name: "catalog-name", path: "ephemeral/skills/actual" }, "skills/actual");
  });

  it("maps direct skill markdown file from filename", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "actual.md"), "# skill");
    await expectTarget(root, { type: "skill", name: "catalog-name", path: "ephemeral/skills/actual.md" }, "skills/actual.md");
  });

  it("maps extension directory wrappers and direct extension files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "extensions", "wrapped"), { recursive: true });
    await writeFile(join(root, "ephemeral", "extensions", "wrapped", "index.ts"), "export default () => {};\n");
    await mkdir(join(root, "ephemeral", "extensions"), { recursive: true });
    await writeFile(join(root, "ephemeral", "extensions", "direct.js"), "export default () => {};\n");

    await expectTarget(root, { type: "extension", name: "wrapped-name", path: "ephemeral/extensions/wrapped" }, "extensions/wrapped");
    await expectTarget(root, { type: "extension", name: "direct-name", path: "ephemeral/extensions/direct.js" }, "extensions/direct.js");
  });

  it("maps prompts and themes from filenames", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "prompts"), { recursive: true });
    await mkdir(join(root, "ephemeral", "themes"), { recursive: true });
    await writeFile(join(root, "ephemeral", "prompts", "ask.md"), "Prompt");
    await writeFile(join(root, "ephemeral", "themes", "dark.json"), "{}");

    await expectTarget(root, { type: "prompt", name: "asker", path: "ephemeral/prompts/ask.md" }, "prompts/ask.md");
    await expectTarget(root, { type: "theme", name: "darkness", path: "ephemeral/themes/dark.json" }, "themes/dark.json");
  });

  it("rejects wrong source shape", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "missing-skill-md"), { recursive: true });
    await mkdir(join(root, "ephemeral", "extensions", "wrapped"), { recursive: true });
    await writeFile(join(root, "ephemeral", "extensions", "wrong.txt"), "nope");
    await mkdir(join(root, "ephemeral", "prompts"), { recursive: true });
    await writeFile(join(root, "ephemeral", "prompts", "wrong.txt"), "nope");

    await expect(deriveTargetPath(root, { type: "skill", name: "bad-skill", path: "ephemeral/skills/missing-skill-md" })).rejects.toMatchObject({ code: "invalid_source_shape" });
    await expect(deriveTargetPath(root, { type: "extension", name: "bad-ext-dir", path: "ephemeral/extensions/wrapped" })).rejects.toMatchObject({ code: "invalid_source_shape" });
    await expect(deriveTargetPath(root, { type: "extension", name: "bad-ext-file", path: "ephemeral/extensions/wrong.txt" })).rejects.toMatchObject({ code: "invalid_source_shape" });
    await expect(deriveTargetPath(root, { type: "prompt", name: "bad-prompt", path: "ephemeral/prompts/wrong.txt" })).rejects.toMatchObject({ code: "invalid_source_shape" });
  });

  it("reports target collision groups when loading the catalog", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "same"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "same", "SKILL.md"), "# one");
    await mkdir(join(root, "node_modules", "pkg", "skills", "same"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "skills", "same", "SKILL.md"), "# two");
    await writeFile(join(root, "resources.json"), JSON.stringify({ version: 1, resources: [] }));
    await mkdir(join(root, "ephemeral"), { recursive: true });
    await writeFile(join(root, "ephemeral", "resources.json"), JSON.stringify({
      version: 1,
      resources: [
        { type: "skill", name: "one", path: "ephemeral/skills/same" },
        { type: "skill", name: "two", path: "node_modules/pkg/skills/same" },
      ],
    }));

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.some((p) => p.code === "target_collision" && p.path === "skills/same")).toBe(true);
  });

  it("reports target collisions between ephemeral resources and always-on resources", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "same"), { recursive: true });
    await writeFile(join(root, "skills", "same", "SKILL.md"), "# always");
    await mkdir(join(root, "ephemeral", "skills", "same"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "same", "SKILL.md"), "# ephemeral");
    await writeFile(join(root, "resources.json"), JSON.stringify({
      version: 1,
      resources: [{ type: "skill", name: "always", path: "skills/same" }],
    }));
    await mkdir(join(root, "ephemeral"), { recursive: true });
    await writeFile(join(root, "ephemeral", "resources.json"), JSON.stringify({
      version: 1,
      resources: [{ type: "skill", name: "optional", path: "ephemeral/skills/same" }],
    }));

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.some((p) => p.code === "target_collision" && p.path === "skills/same" && p.identity === "skill:always,skill:optional")).toBe(true);
  });
});
