import type { BundleDisplayNode } from "./bundles.js";
import type { ResourceDisplayRow } from "./resource-display.js";

export interface ResourceMatchOptions {
  bundleName?: string;
  includeBundleName?: boolean;
}

export interface FilterBundleDisplayTreeOptions {
  includeBundleChildrenOnBundleMatch: boolean;
  includeBundleNameForChildren: boolean;
}

export interface SearchResourceDisplayRowsResult {
  resourceMatches: ResourceDisplayRow[];
  bundleOnlyMatches: BundleDisplayNode[];
}

export function normalizeResourceQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function includesQuery(value: string | undefined, query: string): boolean {
  return Boolean(value && value.toLocaleLowerCase().includes(query));
}

export function resourceMatchesQuery(row: ResourceDisplayRow, query: string, options: ResourceMatchOptions = {}): boolean {
  const normalizedQuery = normalizeResourceQuery(query);
  if (!normalizedQuery) return true;

  return (
    includesQuery(row.type, normalizedQuery) ||
    includesQuery(row.name, normalizedQuery) ||
    includesQuery(row.identity, normalizedQuery) ||
    includesQuery(row.description, normalizedQuery) ||
    (options.includeBundleName === true && includesQuery(options.bundleName ?? row.bundle, normalizedQuery))
  );
}

export function bundleMatchesQuery(node: BundleDisplayNode, query: string): boolean {
  const normalizedQuery = normalizeResourceQuery(query);
  if (!normalizedQuery) return true;
  return includesQuery(node.type, normalizedQuery) || includesQuery(node.name, normalizedQuery) || includesQuery(node.id, normalizedQuery);
}

function cloneBundleWithChildren(node: BundleDisplayNode, children: BundleDisplayNode[], childResources: ResourceDisplayRow[]): BundleDisplayNode {
  return {
    ...node,
    children,
    childResources,
  };
}

function resourceForNode(node: BundleDisplayNode): ResourceDisplayRow | undefined {
  return node.resource;
}

export function filterBundleDisplayTreeByQuery(tree: BundleDisplayNode[], query: string, options: FilterBundleDisplayTreeOptions): BundleDisplayNode[] {
  const normalizedQuery = normalizeResourceQuery(query);
  if (!normalizedQuery) return [...tree];

  const filtered: BundleDisplayNode[] = [];
  for (const node of tree) {
    if (node.kind === "resource") {
      const resource = resourceForNode(node);
      if (resource && resourceMatchesQuery(resource, normalizedQuery)) filtered.push(node);
      continue;
    }

    const bundleMatches = bundleMatchesQuery(node, normalizedQuery);
    const children = node.children ?? [];

    if (bundleMatches && options.includeBundleChildrenOnBundleMatch) {
      filtered.push(cloneBundleWithChildren(node, [...children], [...(node.childResources ?? [])]));
      continue;
    }

    const matchingChildren = children.filter((child) => {
      const resource = resourceForNode(child);
      return resource ? resourceMatchesQuery(resource, normalizedQuery, { bundleName: node.name, includeBundleName: options.includeBundleNameForChildren }) : false;
    });

    if (bundleMatches || matchingChildren.length > 0) {
      filtered.push(cloneBundleWithChildren(node, matchingChildren, matchingChildren.flatMap((child) => (child.resource ? [child.resource] : []))));
    }
  }

  return filtered;
}

function bundleHasDirectResourceMatch(node: BundleDisplayNode, query: string): boolean {
  return (node.childResources ?? []).some((row) => resourceMatchesQuery(row, query));
}

export function searchResourceDisplayRows(rows: ResourceDisplayRow[], tree: BundleDisplayNode[], query: string): SearchResourceDisplayRowsResult {
  const normalizedQuery = normalizeResourceQuery(query);
  if (!normalizedQuery) return { resourceMatches: [...rows], bundleOnlyMatches: [] };

  const resourceMatches = rows.filter((row) => resourceMatchesQuery(row, normalizedQuery));
  const resourceMatchIds = new Set(resourceMatches.map((row) => row.identity));
  const bundleOnlyMatches: BundleDisplayNode[] = [];

  for (const node of tree) {
    if (node.kind !== "bundle" || !bundleMatchesQuery(node, normalizedQuery)) continue;

    if (bundleHasDirectResourceMatch(node, normalizedQuery)) {
      for (const row of node.childResources ?? []) {
        if (!resourceMatchIds.has(row.identity)) {
          resourceMatches.push(row);
          resourceMatchIds.add(row.identity);
        }
      }
    } else {
      bundleOnlyMatches.push(node);
    }
  }

  return { resourceMatches, bundleOnlyMatches };
}
