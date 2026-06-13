import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function invoke(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("installed package shape", () => {
  it("works from a packed dependency inside an example host package", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ephemeral-installed-package-"));

    try {
      const packDir = join(root, "pack");
      const hostDir = join(root, "host");
      const agentDir = join(root, "agent");
      const projectDir = join(root, "project");
      await mkdir(packDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });

      const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", packDir], { cwd: repoRoot });
      const tarballName = stdout.trim().split(/\n/).at(-1);
      expect(tarballName).toMatch(/\.tgz$/);
      const tarball = join(packDir, tarballName!);
      expect(existsSync(tarball)).toBe(true);

      const { stdout: tarList } = await execFileAsync("tar", ["-tzf", tarball]);
      for (const expected of [
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/README.md",
        "package/LICENSE",
        "package/docs/create-example-package.md",
        "package/examples/minimal-skill-package/package.json",
        "package/examples/minimal-skill-package/ephemeral/resources.json",
      ]) {
        expect(tarList).toContain(expected);
      }

      await cp(join(repoRoot, "examples", "minimal-skill-package"), hostDir, { recursive: true });
      const packageJsonPath = join(hostDir, "package.json");
      const hostPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
      hostPackage.dependencies["@tarmo-randma/pi-ephemeral"] = tarball;
      await writeFile(packageJsonPath, `${JSON.stringify(hostPackage, null, 2)}\n`);

      await execFileAsync("npm", ["install"], { cwd: hostDir });
      expect(existsSync(join(hostDir, "node_modules", "@tarmo-randma", "pi-ephemeral", "dist", "index.js"))).toBe(true);

      const installedHostPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
      expect(installedHostPackage.pi.extensions).toEqual(["./node_modules/@tarmo-randma/pi-ephemeral/dist/index.js"]);
      expect(installedHostPackage.pi.skills).toBeUndefined();

      const base = ["--package", hostDir, "--agent-dir", agentDir, "--cwd", projectDir];
      const list = await invoke(["list", "--json", ...base]);
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout).resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity: "skill:ephemeral-example", active: { global: false, project: false } }),
      ]));

      const info = await invoke(["info", "skill", "ephemeral-example", "--json", ...base]);
      expect(info.exitCode).toBe(0);
      expect(JSON.parse(info.stdout).resource).toMatchObject({ type: "skill", name: "ephemeral-example" });

      const enable = await invoke(["enable", "skill", "ephemeral-example", "--global", ...base]);
      expect(enable.exitCode).toBe(0);

      const status = await invoke(["status", "--json", ...base]);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout).global).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "skill", name: "ephemeral-example" }),
      ]));

      const skillLink = join(agentDir, "skills", "ephemeral-example");
      const resolvedSkill = await realpath(skillLink);
      expect(resolvedSkill).toContain(await realpath(hostDir));

      const repair = await invoke(["repair", "--all", ...base]);
      expect(repair.exitCode).toBe(0);

      const disable = await invoke(["disable", "skill", "ephemeral-example", "--global", ...base]);
      expect(disable.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
