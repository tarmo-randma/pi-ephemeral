import { describe, expect, it } from "vitest";
import { buildBundleDisplayTree, type BundleDisplayNode } from "../../src/core/bundles.js";
import type { ResourceDisplayRow } from "../../src/core/resource-display.js";
import {
  bundleMatchesQuery,
  filterBundleDisplayTreeByQuery,
  normalizeResourceQuery,
  resourceMatchesQuery,
  searchResourceDisplayRows,
} from "../../src/core/resource-search.js";
import type { LoadedResource, ResourceType } from "../../src/core/types.js";

function resource(type: ResourceType, name: string, options: { bundle?: string; description?: string } = {}): LoadedResource {
  const targetPrefix = type === "extension" ? "extensions" : `${type}s`;
  return {
    identity: `${type}:${name}`,
    scope: "ephemeral",
    catalogPath: "ephemeral/resources.json",
    targetPath: `${targetPrefix}/${name}`,
    record: {
      type,
      name,
      path: `ephemeral/${targetPrefix}/${name}`,
      ...(options.description ? { description: options.description } : {}),
      ...(options.bundle ? { bundle: options.bundle } : {}),
    },
  };
}

function fixtureTree(): BundleDisplayNode[] {
  return buildBundleDisplayTree({
    resources: [
      resource("skill", "grill-me", { description: "unbundled critique" }),
      resource("extension", "pi-web-access", { bundle: "pi-web-access", description: "Browser tools" }),
      resource("skill", "librarian", { bundle: "pi-web-access", description: "Evidence-backed open-source library research" }),
      resource("prompt", "web-research", { bundle: "pi-web-access", description: "Research the web" }),
      resource("theme", "dark", { description: "quiet colors" }),
    ],
    globalActivations: [],
    projectActivations: [],
    context: "project",
  });
}

function fixtureRows(): ResourceDisplayRow[] {
  return fixtureTree().flatMap((node) => (node.kind === "resource" && node.resource ? [node.resource] : (node.childResources ?? [])));
}

function bundle(tree = fixtureTree(), name = "pi-web-access"): BundleDisplayNode {
  const node = tree.find((candidate) => candidate.kind === "bundle" && candidate.name === name);
  expect(node).toBeDefined();
  return node!;
}

function row(identity: string): ResourceDisplayRow {
  const found = fixtureRows().find((candidate) => candidate.identity === identity);
  expect(found).toBeDefined();
  return found!;
}

describe("resource search helpers", () => {
  it("normalizes queries by trimming and lowercasing", () => {
    expect(normalizeResourceQuery("  LiBrArY Research  ")).toBe("library research");
  });

  it("matches resource fields with case-insensitive substring checks", () => {
    expect(resourceMatchesQuery(row("skill:librarian"), "skill")).toBe(true);
    expect(resourceMatchesQuery(row("skill:grill-me"), "rill")).toBe(true);
    expect(resourceMatchesQuery(row("skill:librarian"), "skill:librarian")).toBe(true);
    expect(resourceMatchesQuery(row("skill:librarian"), "library research")).toBe(true);
    expect(resourceMatchesQuery(row("skill:librarian"), "quiet colors")).toBe(false);
  });

  it("matches bundle context only when requested", () => {
    expect(resourceMatchesQuery(row("skill:librarian"), "pi-web-access", { bundleName: "pi-web-access" })).toBe(false);
    expect(resourceMatchesQuery(row("skill:librarian"), "pi-web-access", { bundleName: "pi-web-access", includeBundleName: true })).toBe(true);
  });

  it("matches bundle nodes by bundle type and name", () => {
    expect(bundleMatchesQuery(bundle(), "bundle")).toBe(true);
    expect(bundleMatchesQuery(bundle(), "WEB-access")).toBe(true);
    expect(bundleMatchesQuery(bundle(), "librarian")).toBe(false);
  });

  it("filters tree to the parent bundle and matching child rows for child matches", () => {
    const original = fixtureTree();
    const filtered = filterBundleDisplayTreeByQuery(original, "librarian", {
      includeBundleChildrenOnBundleMatch: true,
      includeBundleNameForChildren: true,
    });

    expect(filtered.map((node) => `${node.kind}:${node.name}`)).toEqual(["bundle:pi-web-access"]);
    expect(filtered[0]?.children?.map((child) => `${child.type}:${child.name}:${child.depth}`)).toEqual(["skill:librarian:1"]);
    expect(filtered[0]?.childResources?.map((child) => child.identity)).toEqual(["skill:librarian"]);
    expect(filtered[0]).not.toBe(bundle(original));
    expect(bundle(original).children?.map((child) => child.name)).toEqual(["pi-web-access", "librarian", "web-research"]);
  });

  it("includes all bundle children when the parent bundle matches", () => {
    const filtered = filterBundleDisplayTreeByQuery(fixtureTree(), "pi-web-access", {
      includeBundleChildrenOnBundleMatch: true,
      includeBundleNameForChildren: true,
    });

    expect(filtered.map((node) => `${node.kind}:${node.name}`)).toEqual(["bundle:pi-web-access"]);
    expect(filtered[0]?.children?.map((child) => `${child.type}:${child.name}`)).toEqual(["extension:pi-web-access", "skill:librarian", "prompt:web-research"]);
  });

  it("returns only matching unbundled root resources", () => {
    const filtered = filterBundleDisplayTreeByQuery(fixtureTree(), "critique", {
      includeBundleChildrenOnBundleMatch: true,
      includeBundleNameForChildren: true,
    });

    expect(filtered.map((node) => `${node.kind}:${node.type}:${node.name}`)).toEqual(["resource:skill:grill-me"]);
  });

  it("returns direct resource matches and typed bundle-only matches for info search", () => {
    const tree = fixtureTree();

    expect(searchResourceDisplayRows(fixtureRows(), tree, "librarian")).toMatchObject({
      resourceMatches: [{ identity: "skill:librarian" }],
      bundleOnlyMatches: [],
    });

    const result = searchResourceDisplayRows(fixtureRows(), tree, "bundle:pi-web-access");
    expect(result.resourceMatches).toEqual([]);
    expect(result.bundleOnlyMatches).toHaveLength(1);
    expect(result.bundleOnlyMatches[0]).toMatchObject({ kind: "bundle", name: "pi-web-access" });
    expect(result.bundleOnlyMatches[0]?.childResources?.map((child) => child.identity)).toEqual(["extension:pi-web-access", "skill:librarian", "prompt:web-research"]);
  });
});
