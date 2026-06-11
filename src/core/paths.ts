import path from "node:path";
import { errorProblem } from "./errors.js";
import type { CatalogProblem, CatalogScope } from "./types.js";

const ALLOWED_EPHEMERAL_PREFIXES = [
  "ephemeral/skills/",
  "ephemeral/extensions/",
  "ephemeral/prompts/",
  "ephemeral/themes/",
  "node_modules/",
] as const;

const ALLOWED_ALWAYS_ON_PREFIXES = [
  "extensions/",
  "skills/",
  "prompts/",
  "themes/",
  "node_modules/",
] as const;

export function allowedPrefixesFor(scope: CatalogScope): readonly string[] {
  return scope === "ephemeral" ? ALLOWED_EPHEMERAL_PREFIXES : ALLOWED_ALWAYS_ON_PREFIXES;
}

export function validateCatalogPath(resourcePath: unknown, scope: CatalogScope, identity?: string): CatalogProblem[] {
  if (typeof resourcePath !== "string") {
    return [errorProblem("invalid_path", "Resource path must be a string", { identity })];
  }

  if (resourcePath.includes("\\")) {
    return [errorProblem("invalid_path", "Resource path must use forward slashes, not backslashes", { identity, path: resourcePath })];
  }
  if (resourcePath.length === 0) {
    return [errorProblem("invalid_path", "Resource path must not be empty", { identity, path: resourcePath })];
  }
  if (path.posix.isAbsolute(resourcePath) || /^[a-zA-Z]:\//.test(resourcePath)) {
    return [errorProblem("absolute_path", "Resource path must be package-root-relative", { identity, path: resourcePath })];
  }

  const segments = resourcePath.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return [errorProblem("empty_path_segment", "Resource path must not contain empty path segments", { identity, path: resourcePath })];
  }
  if (segments.some((segment) => segment === "..")) {
    return [errorProblem("path_traversal", "Resource path must not contain traversal segments", { identity, path: resourcePath })];
  }

  if (!allowedPrefixesFor(scope).some((prefix) => resourcePath.startsWith(prefix))) {
    return [errorProblem("unsupported_path_prefix", `Resource path uses an unsupported ${scope} prefix`, { identity, path: resourcePath })];
  }

  return [];
}

export function resolveCatalogPath(root: string, resourcePath: string): string {
  return path.resolve(root, resourcePath);
}

export function basenameWithoutTrailingSlash(resourcePath: string): string {
  const normalized = resourcePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return path.posix.basename(normalized);
}
