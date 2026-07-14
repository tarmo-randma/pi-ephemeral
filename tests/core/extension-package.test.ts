import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectExtensionPackageDirectory } from "../../src/core/extension-package.js";

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-eph-extension-package-"));
  const packagePath = join(root, "example-native-package");
  await mkdir(packagePath);
  return packagePath;
}

describe("inspectExtensionPackageDirectory", () => {
  it("recognizes one usable extension entry and derives contained resource candidates locally", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "extension.js"), "export default () => {};\n");
    await mkdir(join(root, "custom-skill"));
    await writeFile(join(root, "custom-skill", "SKILL.md"), "# custom\n");
    await mkdir(join(root, "skills", "brainstorming"), { recursive: true });
    await writeFile(join(root, "skills", "brainstorming", "SKILL.md"), "# brainstorming\n");
    await mkdir(join(root, "prompts"));
    await writeFile(join(root, "prompts", "review.md"), "Review\n");
    await mkdir(join(root, "themes"));
    await writeFile(join(root, "themes", "dark.json"), "{}\n");
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "example-native-package",
      pi: {
        extensions: ["./dist/extension.js", "./dist/missing.js"],
        skills: ["./custom-skill", "../outside-skill"],
        prompts: ["./prompts"],
        themes: ["./themes"],
      },
    }));

    await expect(inspectExtensionPackageDirectory(root)).resolves.toEqual({
      extensionEntries: ["./dist/extension.js"],
      containedResources: [
        { type: "skill", name: "brainstorming", path: "skills/brainstorming" },
        { type: "skill", name: "custom-skill", path: "custom-skill" },
        { type: "prompt", name: "review", path: "prompts/review.md" },
        { type: "theme", name: "dark", path: "themes/dark.json" },
      ],
    });
  });

  it("does not recognize malformed manifests or manifests without an existing declared extension", async () => {
    const malformed = await packageRoot();
    await writeFile(join(malformed, "package.json"), "not json");
    await expect(inspectExtensionPackageDirectory(malformed)).resolves.toBeUndefined();

    const missing = await packageRoot();
    await writeFile(join(missing, "package.json"), JSON.stringify({ pi: { extensions: ["./missing.js"] } }));
    await expect(inspectExtensionPackageDirectory(missing)).resolves.toBeUndefined();
  });
});
