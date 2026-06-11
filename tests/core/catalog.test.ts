import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalogSet } from "../../src/core/catalog.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-eph-catalog-"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

describe("loadCatalogSet", () => {
  it("loads always-on and ephemeral resources and rejects duplicate identities across both", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "foo"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: Foo\n---\n");
    await writeJson(join(root, "resources.json"), { version: 1, resources: [{ type: "skill", name: "foo", path: "skills/foo", description: "Always" }] });
    await writeJson(join(root, "ephemeral", "resources.json"), { version: 1, resources: [{ type: "skill", name: "foo", path: "ephemeral/skills/foo", description: "Optional" }] });

    const loaded = await loadCatalogSet(root);

    expect(loaded.alwaysOn).toHaveLength(1);
    expect(loaded.ephemeral).toHaveLength(1);
    expect(loaded.problems.some((p) => p.code === "duplicate_identity" && p.identity === "skill:foo")).toBe(true);
  });

  it("reports invalid names and unsupported resource types", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    await mkdir(join(root, "ephemeral"));
    await writeJson(join(root, "ephemeral", "resources.json"), {
      version: 1,
      resources: [
        { type: "skill", name: "Bad Name", path: "ephemeral/skills/bad" },
        { type: "skills", name: "plural", path: "ephemeral/skills/plural" },
      ],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.map((p) => p.code)).toContain("invalid_name");
    expect(loaded.problems.map((p) => p.code)).toContain("unsupported_type");
  });

  it.each([
    ["absolute_path", "/tmp/skill"],
    ["path_traversal", "ephemeral/skills/../secret"],
    ["empty_path_segment", "ephemeral/skills//foo"],
    ["unsupported_path_prefix", "skills/foo"],
    ["invalid_path", "ephemeral\\skills\\foo"],
  ])("rejects unsafe ephemeral path: %s", async (code, resourcePath) => {
    const root = await tempRoot();
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    await mkdir(join(root, "ephemeral"));
    await writeJson(join(root, "ephemeral", "resources.json"), {
      version: 1,
      resources: [{ type: "skill", name: "foo", path: resourcePath }],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.some((p) => p.code === code)).toBe(true);
    if (code === "invalid_path") {
      expect(loaded.ephemeral.find((resource) => resource.identity === "skill:foo")?.targetPath).toBeUndefined();
    }
  });

  it("validates read-only always-on paths with always-on prefixes and warning", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "resources.json"), {
      version: 1,
      resources: [
        { type: "skill", name: "local", path: "skills/local" },
        { type: "extension", name: "dep", path: "node_modules/pkg/index.js" },
        { type: "prompt", name: "bad", path: "ephemeral/prompts/bad.md" },
        { type: "skill", name: "backslash", path: "skills\\backslash" },
      ],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.some((p) => p.code === "read_only_catalog" && p.severity === "warning")).toBe(true);
    expect(loaded.problems.some((p) => p.code === "unsupported_path_prefix" && p.identity === "prompt:bad")).toBe(true);
    expect(loaded.problems.some((p) => p.code === "invalid_path" && p.identity === "skill:backslash" && p.path === "skills\\backslash")).toBe(true);
    expect(loaded.alwaysOn.find((resource) => resource.identity === "skill:backslash")?.targetPath).toBeUndefined();
  });

  it("reports duplicate catalog entries within a file", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    await mkdir(join(root, "ephemeral"));
    await writeJson(join(root, "ephemeral", "resources.json"), {
      version: 1,
      resources: [
        { type: "theme", name: "one", path: "ephemeral/themes/one.json" },
        { type: "theme", name: "one", path: "ephemeral/themes/other.json" },
      ],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.some((p) => p.code === "duplicate_catalog_entry" && p.identity === "theme:one")).toBe(true);
  });

  it("loads optional bundle metadata on resources", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "foo"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: Foo\n---\n");
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    await writeJson(join(root, "ephemeral", "resources.json"), {
      version: 1,
      resources: [{ type: "skill", name: "foo", path: "ephemeral/skills/foo", bundle: "my-bundle" }],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.ephemeral[0]?.record.bundle).toBe("my-bundle");
    expect(loaded.problems.some((p) => p.code === "invalid_bundle")).toBe(false);
  });

  it.each(["", "bad name", "bad/path/extra", "bad\\name", ".."])("rejects invalid bundle metadata: %s", async (bundle) => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "foo"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: Foo\n---\n");
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    await writeJson(join(root, "ephemeral", "resources.json"), {
      version: 1,
      resources: [{ type: "skill", name: "foo", path: "ephemeral/skills/foo", bundle }],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.problems.some((p) => p.code === "invalid_bundle" && p.identity === "skill:foo")).toBe(true);
  });

  it("accepts scoped npm-style bundle names", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ephemeral", "skills", "foo"), { recursive: true });
    await writeFile(join(root, "ephemeral", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: Foo\n---\n");
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    await writeJson(join(root, "ephemeral", "resources.json"), {
      version: 1,
      resources: [{ type: "skill", name: "foo", path: "ephemeral/skills/foo", bundle: "@scope/package" }],
    });

    const loaded = await loadCatalogSet(root);

    expect(loaded.ephemeral[0]?.record.bundle).toBe("@scope/package");
    expect(loaded.problems.some((p) => p.code === "invalid_bundle")).toBe(false);
  });

  it("requires always-on catalog and treats ephemeral catalog as optional", async () => {
    const missingRoot = await tempRoot();
    const missing = await loadCatalogSet(missingRoot);
    expect(missing.problems.some((p) => p.code === "missing_catalog" && p.path === "resources.json")).toBe(true);

    const root = await tempRoot();
    await writeJson(join(root, "resources.json"), { version: 1, resources: [] });
    const loaded = await loadCatalogSet(root);
    expect(loaded.problems.some((p) => p.path === "ephemeral/resources.json" && p.code === "missing_catalog")).toBe(false);
    expect(loaded.resources).toEqual([]);
  });
});
