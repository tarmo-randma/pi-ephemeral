import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveProjectRoot } from "../../src/core/project-index.js";

const exec = promisify(execFile);
async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(process.cwd(), `node_modules/.tmp-${prefix}-`));
}

async function outsideRepoTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-ephemeral-${prefix}-`));
}

describe("project root resolution", () => {
  it("uses git rev-parse --show-toplevel from the starting cwd", async () => {
    const repo = await tempDir("git-root");
    await exec("git", ["init"], { cwd: repo });
    const nested = join(repo, "a", "b");
    await mkdir(nested, { recursive: true });
    await expect(resolveProjectRoot(nested)).resolves.toBe(repo);
  });

  it("falls back to the starting cwd outside git", async () => {
    const dir = await outsideRepoTempDir("outside-git");
    await expect(resolveProjectRoot(dir)).resolves.toBe(dir);
  });
});
