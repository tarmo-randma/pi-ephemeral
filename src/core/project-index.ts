import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StateFileError } from "./state.js";

const exec = promisify(execFile);

export interface ProjectIndex {
  version: 1;
  projects: string[];
}

export function globalStatePath(agentDir: string): string {
  return join(agentDir, "pi-ephemeral-global.json");
}

export function projectIndexPath(agentDir: string): string {
  return join(agentDir, "pi-ephemeral-projects.json");
}

export function projectStatePath(projectRoot: string): string {
  return join(projectRoot, ".pi", "pi-ephemeral.json");
}

export function normalizeProjectIndex(index: ProjectIndex): ProjectIndex {
  return { version: 1, projects: [...new Set(index.projects)].sort() };
}

export function canonicalProjectIndexText(index: ProjectIndex): string {
  return `${JSON.stringify(normalizeProjectIndex(index), null, 2)}\n`;
}

export async function loadProjectIndex(indexPath: string): Promise<ProjectIndex> {
  let text: string;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
    throw error;
  }
  try {
    const raw = JSON.parse(text) as Partial<ProjectIndex>;
    if (raw.version !== 1 || !Array.isArray(raw.projects) || raw.projects.some((project) => typeof project !== "string")) {
      throw new StateFileError("invalid_project_index", indexPath, `Invalid project index ${indexPath}`);
    }
    return normalizeProjectIndex({ version: 1, projects: raw.projects });
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StateFileError("malformed_state_json", indexPath, `Malformed JSON in ${indexPath}: ${error.message}`);
    }
    throw error;
  }
}

export async function updateProjectIndex(indexPath: string, projects: string[]): Promise<boolean> {
  const next = canonicalProjectIndexText({ version: 1, projects });
  try {
    const current = await readFile(indexPath, "utf8");
    if (current === next) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, next, "utf8");
  return true;
}

export async function addProjectToIndex(indexPath: string, projectRoot: string): Promise<boolean> {
  const index = await loadProjectIndex(indexPath);
  return updateProjectIndex(indexPath, [...index.projects, projectRoot]);
}

export async function removeProjectFromIndex(indexPath: string, projectRoot: string): Promise<boolean> {
  const index = await loadProjectIndex(indexPath);
  return updateProjectIndex(indexPath, index.projects.filter((project) => project !== projectRoot));
}

export async function pruneProjectIndex(indexPath: string, keepProject: (projectRoot: string) => Promise<boolean>): Promise<ProjectIndex> {
  const index = await loadProjectIndex(indexPath);
  const kept: string[] = [];
  for (const project of index.projects) {
    if (await keepProject(project)) kept.push(project);
  }
  await updateProjectIndex(indexPath, kept);
  return normalizeProjectIndex({ version: 1, projects: kept });
}

export async function projectExists(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(projectRoot)).isDirectory();
  } catch {
    return false;
  }
}

export async function hasProjectState(projectRoot: string): Promise<boolean> {
  try {
    await access(projectStatePath(projectRoot));
    return true;
  } catch {
    return false;
  }
}

export async function resolveProjectRoot(startingCwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: startingCwd });
    return stdout.trim() || startingCwd;
  } catch {
    return startingCwd;
  }
}
