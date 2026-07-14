import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContainedResourceCandidate, ExtensionPackageDirectoryInfo } from "./types.js";

const candidateTypes = ["skill", "prompt", "theme"] as const;
type CandidateType = (typeof candidateTypes)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function containedPath(packageRoot: string, declaredPath: string): string | undefined {
  const resolved = path.resolve(packageRoot, declaredPath);
  const relative = path.relative(packageRoot, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return resolved;
  return undefined;
}

function relativeDisplayPath(packageRoot: string, candidatePath: string): string {
  return path.relative(packageRoot, candidatePath).split(path.sep).join("/");
}

function candidateName(candidatePath: string): string {
  return path.basename(candidatePath, path.extname(candidatePath));
}

async function addCandidate(
  packageRoot: string,
  type: CandidateType,
  candidatePath: string,
  candidates: Map<string, ContainedResourceCandidate>,
): Promise<void> {
  let candidateStat;
  try {
    candidateStat = await stat(candidatePath);
  } catch {
    return;
  }

  const requiredExtension = type === "skill" || type === "prompt" ? ".md" : ".json";
  if (candidateStat.isFile()) {
    if (path.extname(candidatePath) !== requiredExtension) return;
    const displayPath = relativeDisplayPath(packageRoot, candidatePath);
    candidates.set(`${type}:${displayPath}`, { type, name: candidateName(candidatePath), path: displayPath });
    return;
  }
  if (!candidateStat.isDirectory()) return;

  if (type === "skill" && await exists(path.join(candidatePath, "SKILL.md"))) {
    const displayPath = relativeDisplayPath(packageRoot, candidatePath);
    candidates.set(`${type}:${displayPath}`, { type, name: path.basename(candidatePath), path: displayPath });
    return;
  }

  let entries;
  try {
    entries = await readdir(candidatePath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(candidatePath, entry.name);
    if (entry.isFile() && path.extname(entry.name) === requiredExtension) {
      const displayPath = relativeDisplayPath(packageRoot, entryPath);
      candidates.set(`${type}:${displayPath}`, { type, name: candidateName(entry.name), path: displayPath });
    } else if (type === "skill" && entry.isDirectory() && await exists(path.join(entryPath, "SKILL.md"))) {
      const displayPath = relativeDisplayPath(packageRoot, entryPath);
      candidates.set(`${type}:${displayPath}`, { type, name: entry.name, path: displayPath });
    }
  }
}

async function discoverContainedResources(packageRoot: string, pi: Record<string, unknown>): Promise<ContainedResourceCandidate[]> {
  const candidates = new Map<string, ContainedResourceCandidate>();
  for (const type of candidateTypes) {
    const manifestKey = `${type}s`;
    const declared = Array.isArray(pi[manifestKey]) ? pi[manifestKey] : [];
    const paths = new Set<string>([type === "skill" ? "skills" : `${type}s`]);
    for (const value of declared) {
      if (typeof value === "string") paths.add(value);
    }
    for (const declaredPath of paths) {
      const resolved = containedPath(packageRoot, declaredPath);
      if (resolved) await addCandidate(packageRoot, type, resolved, candidates);
    }
  }
  return [...candidates.values()].sort((a, b) => candidateTypes.indexOf(a.type) - candidateTypes.indexOf(b.type) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export async function inspectExtensionPackageDirectory(packageRoot: string): Promise<ExtensionPackageDirectoryInfo | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(manifest) || !isObject(manifest.pi) || !Array.isArray(manifest.pi.extensions)) return undefined;

  const extensionEntries: string[] = [];
  for (const entry of manifest.pi.extensions) {
    if (typeof entry !== "string") continue;
    const resolved = containedPath(packageRoot, entry);
    if (resolved && await exists(resolved)) extensionEntries.push(entry);
  }
  if (extensionEntries.length === 0) return undefined;

  return {
    extensionEntries,
    containedResources: await discoverContainedResources(packageRoot, manifest.pi),
  };
}
