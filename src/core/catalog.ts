import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorProblem, warningProblem } from "./errors.js";
import { inspectExtensionPackageDirectory } from "./extension-package.js";
import { resolveCatalogPath, validateCatalogPath } from "./paths.js";
import { deriveTargetPath, targetErrorToProblem } from "./targets.js";
import { RESOURCE_TYPES, type CatalogProblem, type CatalogScope, type CatalogSet, type LoadedResource, type ResourceCatalogFile, type ResourceRecord, type ResourceType } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BUNDLE_PATTERN = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;

interface RawCatalogLoad {
  catalog?: unknown;
  problems: CatalogProblem[];
}

function identityOf(record: Pick<ResourceRecord, "type" | "name">): string {
  return `${record.type}:${record.name}`;
}

function isResourceType(value: unknown): value is ResourceType {
  return typeof value === "string" && (RESOURCE_TYPES as readonly string[]).includes(value);
}

async function readCatalog(root: string, catalogPath: string, required: boolean): Promise<RawCatalogLoad> {
  try {
    const text = await readFile(join(root, catalogPath), "utf8");
    return { catalog: JSON.parse(text), problems: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        problems: required ? [errorProblem("missing_catalog", `Missing catalog ${catalogPath}`, { path: catalogPath })] : [],
      };
    }
    if (error instanceof SyntaxError) {
      return { problems: [errorProblem("invalid_catalog_json", `Invalid JSON in ${catalogPath}: ${error.message}`, { path: catalogPath })] };
    }
    return { problems: [errorProblem("catalog_read_error", `Could not read catalog ${catalogPath}: ${(error as Error).message}`, { path: catalogPath })] };
  }
}

function parseCatalog(raw: unknown, catalogPath: string): { records: ResourceRecord[]; problems: CatalogProblem[] } {
  const problems: CatalogProblem[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { records: [], problems: [errorProblem("invalid_catalog", "Catalog must be an object", { path: catalogPath })] };
  }

  const maybeCatalog = raw as Partial<ResourceCatalogFile>;
  if (maybeCatalog.version !== 1) {
    problems.push(errorProblem("unsupported_catalog_version", "Catalog version must be 1", { path: catalogPath }));
  }
  if (!Array.isArray(maybeCatalog.resources)) {
    problems.push(errorProblem("invalid_catalog", "Catalog resources must be an array", { path: catalogPath }));
    return { records: [], problems };
  }

  const records: ResourceRecord[] = [];
  maybeCatalog.resources.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      problems.push(errorProblem("invalid_resource", "Resource entry must be an object", { path: `${catalogPath}#resources[${index}]` }));
      return;
    }
    const candidate = item as unknown as Record<string, unknown>;
    const pathForProblem = typeof candidate.path === "string" ? candidate.path : `${catalogPath}#resources[${index}]`;
    const type = candidate.type;
    const name = candidate.name;
    const resourceIdentity = typeof type === "string" && typeof name === "string" ? `${type}:${name}` : undefined;

    if (!isResourceType(type)) {
      problems.push(errorProblem("unsupported_type", "Resource type must be one of skill, extension, prompt, theme", { identity: resourceIdentity, path: pathForProblem }));
      return;
    }
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      problems.push(errorProblem("invalid_name", "Resource name must match ^[a-z0-9][a-z0-9._-]*$", { identity: resourceIdentity, path: pathForProblem }));
      return;
    }
    if (typeof candidate.path !== "string") {
      problems.push(errorProblem("invalid_path", "Resource path must be a string", { identity: `${type}:${name}`, path: pathForProblem }));
      return;
    }
    if (candidate.description !== undefined && typeof candidate.description !== "string") {
      problems.push(errorProblem("invalid_description", "Resource description must be a string", { identity: `${type}:${name}`, path: candidate.path }));
    }
    if (candidate.bundle !== undefined && (typeof candidate.bundle !== "string" || !BUNDLE_PATTERN.test(candidate.bundle))) {
      problems.push(errorProblem("invalid_bundle", "Resource bundle metadata must be a package name like my-bundle or @scope/package", { identity: `${type}:${name}`, path: candidate.path }));
    }
    if (candidate.infra !== undefined && (typeof candidate.infra !== "object" || candidate.infra === null || Array.isArray(candidate.infra))) {
      problems.push(errorProblem("invalid_infra", "Resource infra metadata must be an object", { identity: `${type}:${name}`, path: candidate.path }));
    }

    records.push({
      type,
      name,
      path: candidate.path,
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      ...(typeof candidate.bundle === "string" && BUNDLE_PATTERN.test(candidate.bundle) ? { bundle: candidate.bundle } : {}),
      ...(typeof candidate.infra === "object" && candidate.infra !== null && !Array.isArray(candidate.infra) ? { infra: candidate.infra as Record<string, unknown> } : {}),
    });
  });

  return { records, problems };
}

function validateRecords(records: ResourceRecord[], scope: CatalogScope, catalogPath: string): { loaded: LoadedResource[]; problems: CatalogProblem[] } {
  const loaded: LoadedResource[] = [];
  const problems: CatalogProblem[] = [];
  const seen = new Map<string, number>();

  for (const record of records) {
    const identity = identityOf(record);
    const count = seen.get(identity) ?? 0;
    if (count > 0) {
      problems.push(errorProblem("duplicate_catalog_entry", `Duplicate ${identity} in ${catalogPath}`, { identity, path: record.path }));
    }
    seen.set(identity, count + 1);
    problems.push(...validateCatalogPath(record.path, scope, identity));
    loaded.push({ record, scope, identity, catalogPath });
  }

  if (scope === "always-on" && loaded.length > 0) {
    problems.push(warningProblem("read_only_catalog", "Always-on resources are read-only metadata", { path: catalogPath }));
  }

  return { loaded, problems };
}

function findDuplicateIdentities(resources: LoadedResource[]): CatalogProblem[] {
  const seen = new Map<string, LoadedResource>();
  const reported = new Set<string>();
  const problems: CatalogProblem[] = [];
  for (const resource of resources) {
    const prior = seen.get(resource.identity);
    if (prior && !reported.has(resource.identity)) {
      problems.push(errorProblem("duplicate_identity", `Duplicate resource identity ${resource.identity} across catalogs`, { identity: resource.identity, path: resource.record.path }));
      reported.add(resource.identity);
    } else if (!prior) {
      seen.set(resource.identity, resource);
    }
  }
  return problems;
}

function findTargetCollisions(resources: LoadedResource[]): CatalogProblem[] {
  const byTarget = new Map<string, LoadedResource[]>();
  for (const resource of resources) {
    if (!resource.targetPath) continue;
    const group = byTarget.get(resource.targetPath) ?? [];
    group.push(resource);
    byTarget.set(resource.targetPath, group);
  }

  const problems: CatalogProblem[] = [];
  for (const [targetPath, group] of byTarget) {
    if (group.length > 1 && group.some((resource) => resource.scope === "ephemeral")) {
      problems.push(errorProblem("target_collision", `Multiple resources derive target ${targetPath}`, {
        identity: group.map((resource) => resource.identity).join(","),
        path: targetPath,
      }));
    }
  }
  return problems;
}

export async function loadCatalogSet(root: string): Promise<CatalogSet> {
  const problems: CatalogProblem[] = [];
  const alwaysRaw = await readCatalog(root, "resources.json", true);
  const ephemeralRaw = await readCatalog(root, "ephemeral/resources.json", false);
  problems.push(...alwaysRaw.problems, ...ephemeralRaw.problems);

  const alwaysParsed = alwaysRaw.catalog === undefined ? { records: [], problems: [] } : parseCatalog(alwaysRaw.catalog, "resources.json");
  const ephemeralParsed = ephemeralRaw.catalog === undefined ? { records: [], problems: [] } : parseCatalog(ephemeralRaw.catalog, "ephemeral/resources.json");
  problems.push(...alwaysParsed.problems, ...ephemeralParsed.problems);

  const alwaysValidated = validateRecords(alwaysParsed.records, "always-on", "resources.json");
  const ephemeralValidated = validateRecords(ephemeralParsed.records, "ephemeral", "ephemeral/resources.json");
  problems.push(...alwaysValidated.problems, ...ephemeralValidated.problems);

  const resources = [...alwaysValidated.loaded, ...ephemeralValidated.loaded];
  problems.push(...findDuplicateIdentities(resources));

  for (const resource of resources) {
    const hasPathProblem = problems.some((problem) => problem.identity === resource.identity && problem.path === resource.record.path && ["absolute_path", "path_traversal", "empty_path_segment", "unsupported_path_prefix", "invalid_path"].includes(problem.code));
    if (hasPathProblem) continue;
    try {
      resource.targetPath = await deriveTargetPath(root, resource.record);
      if (resource.record.type === "extension") {
        const extensionPackage = await inspectExtensionPackageDirectory(resolveCatalogPath(root, resource.record.path));
        if (extensionPackage) resource.extensionPackage = extensionPackage;
      }
    } catch (error) {
      const problem = targetErrorToProblem(error);
      if (problem) problems.push(problem);
      else throw error;
    }
  }

  problems.push(...findTargetCollisions(resources));

  return {
    alwaysOn: alwaysValidated.loaded,
    ephemeral: ephemeralValidated.loaded,
    resources,
    problems,
  };
}
