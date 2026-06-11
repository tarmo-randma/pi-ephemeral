import { stat, access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { CatalogValidationError } from "./errors.js";
import { basenameWithoutTrailingSlash, resolveCatalogPath, validateCatalogPath } from "./paths.js";
import type { CatalogProblem, ResourceRecord } from "./types.js";

function invalidSource(record: ResourceRecord, message: string): CatalogValidationError {
  return new CatalogValidationError({
    severity: "error",
    code: "invalid_source_shape",
    message,
    identity: `${record.type}:${record.name}`,
    path: record.path,
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function deriveTargetPath(root: string, record: ResourceRecord): Promise<string> {
  const pathProblems = validateCatalogPath(record.path, record.path.startsWith("ephemeral/") ? "ephemeral" : "always-on", `${record.type}:${record.name}`);
  if (pathProblems.length > 0) {
    throw new CatalogValidationError(pathProblems[0]);
  }

  const sourcePath = resolveCatalogPath(root, record.path);
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw invalidSource(record, `Resource source does not exist: ${record.path}`);
  }

  const sourceBasename = basenameWithoutTrailingSlash(record.path);
  const ext = path.posix.extname(sourceBasename);

  if (record.type === "skill") {
    if (sourceStat.isDirectory()) {
      if (await exists(path.join(sourcePath, "SKILL.md"))) return `skills/${sourceBasename}`;
      throw invalidSource(record, "Skill directories must contain SKILL.md");
    }
    if (sourceStat.isFile() && ext === ".md") return `skills/${sourceBasename}`;
    throw invalidSource(record, "Skill sources must be a .md file or a directory containing SKILL.md");
  }

  if (record.type === "extension") {
    if (sourceStat.isDirectory()) {
      if ((await exists(path.join(sourcePath, "index.ts"))) || (await exists(path.join(sourcePath, "index.js")))) {
        return `extensions/${sourceBasename}`;
      }
      throw invalidSource(record, "Extension directories must contain index.ts or index.js");
    }
    if (sourceStat.isFile() && (ext === ".ts" || ext === ".js")) return `extensions/${sourceBasename}`;
    throw invalidSource(record, "Extension sources must be a .ts/.js file or a directory containing index.ts/index.js");
  }

  if (record.type === "prompt") {
    if (sourceStat.isFile() && ext === ".md") return `prompts/${sourceBasename}`;
    throw invalidSource(record, "Prompt sources must be .md files");
  }

  if (record.type === "theme") {
    if (sourceStat.isFile() && ext === ".json") return `themes/${sourceBasename}`;
    throw invalidSource(record, "Theme sources must be .json files");
  }

  throw invalidSource(record, `Unsupported resource type: ${(record as { type: string }).type}`);
}

export function targetErrorToProblem(error: unknown): CatalogProblem | undefined {
  if (error instanceof CatalogValidationError) {
    return {
      severity: error.severity,
      code: error.code,
      message: error.message,
      identity: error.identity,
      path: error.path,
    };
  }
  return undefined;
}
