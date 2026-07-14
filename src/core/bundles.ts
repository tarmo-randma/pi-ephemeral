import { buildResourceDisplayRows, compareResourceDisplayRows, type ResourceDisplayRow } from "./resource-display.js";
import type { ActivationRecord } from "./state.js";
import type { ContainedResourceCandidate, ExtensionPackageDirectoryInfo, LoadedResource, ResourceType } from "./types.js";

export const ROOT_TYPE_DISPLAY_ORDER = ["bundle", "extension", "skill", "prompt", "theme"] as const;
export type RootDisplayType = (typeof ROOT_TYPE_DISPLAY_ORDER)[number];
export type BundleNodeKind = "bundle" | "resource" | "contained-resource";
export type BundleUse = "" | "always" | "global" | "project" | "always*" | "global*" | "project*";
export type BundleAction = "" | "enable" | "disable";

export interface BuildBundleDisplayTreeOptions {
  resources: LoadedResource[];
  globalActivations: ActivationRecord[];
  projectActivations: ActivationRecord[];
  context: "global" | "project";
  warningsByIdentity?: Map<string, string[]>;
}

export interface BundleDisplayNode {
  id: string;
  kind: BundleNodeKind;
  depth: 0 | 1;
  type: RootDisplayType;
  name: string;
  use: BundleUse;
  action: BundleAction;
  children?: BundleDisplayNode[];
  resource?: ResourceDisplayRow;
  childResources?: ResourceDisplayRow[];
  extensionPackage?: ExtensionPackageDirectoryInfo;
  containedResource?: ContainedResourceCandidate;
  containedIn?: string;
  warnings: string[];
}

function rootTypeOrder(type: RootDisplayType): number {
  const index = ROOT_TYPE_DISPLAY_ORDER.indexOf(type);
  return index === -1 ? ROOT_TYPE_DISPLAY_ORDER.length : index;
}

export function compareBundleDisplayNodes(a: Pick<BundleDisplayNode, "type" | "name" | "resource">, b: Pick<BundleDisplayNode, "type" | "name" | "resource">): number {
  if (a.resource && b.resource) return compareResourceDisplayRows(a.resource, b.resource);
  return rootTypeOrder(a.type) - rootTypeOrder(b.type) || a.name.localeCompare(b.name);
}

function resourceNode(row: ResourceDisplayRow, depth: 0 | 1): BundleDisplayNode {
  return {
    id: row.identity,
    kind: "resource",
    depth,
    type: row.type,
    name: row.name,
    use: row.use,
    action: row.action,
    resource: row,
    ...(row.extensionPackage ? { extensionPackage: row.extensionPackage } : {}),
    warnings: row.warnings,
  };
}

function containedResourceNode(bundleName: string, candidate: ContainedResourceCandidate): BundleDisplayNode {
  return {
    id: `contained:${bundleName}:${candidate.type}:${candidate.path}`,
    kind: "contained-resource",
    depth: 1,
    type: candidate.type,
    name: candidate.name,
    use: "",
    action: "",
    containedResource: candidate,
    containedIn: bundleName,
    warnings: [],
  };
}

function deriveBundleUse(children: ResourceDisplayRow[], context: "global" | "project"): BundleUse {
  const activeUses = children.map((child) => child.use).filter((use) => use !== "");
  if (activeUses.length === 0) return "";

  const allChildrenActive = activeUses.length === children.length;
  const uniqueUses = new Set(activeUses);
  if (allChildrenActive && uniqueUses.size === 1) return activeUses[0] ?? "";

  if (context === "project") {
    if (uniqueUses.has("project")) return "project*";
    if (uniqueUses.has("global")) return "global*";
    if (uniqueUses.has("always")) return "always*";
  } else {
    if (uniqueUses.has("global")) return "global*";
    if (uniqueUses.has("project")) return "project*";
    if (uniqueUses.has("always")) return "always*";
  }

  return "";
}

function deriveBundleAction(children: ResourceDisplayRow[]): BundleAction {
  const hasInactiveEditableChild = children.some((child) => child.action === "enable");
  const hasEditableActiveChild = children.some((child) => child.action === "disable");

  if (!hasInactiveEditableChild && hasEditableActiveChild) return "disable";
  if (hasInactiveEditableChild) return "enable";
  return "";
}

function bundleWarnings(bundleName: string, children: ResourceDisplayRow[]): string[] {
  const hasGlobalChild = children.some((child) => child.use === "global");
  const hasProjectChild = children.some((child) => child.use === "project");
  if (!hasGlobalChild || !hasProjectChild) return [];
  return [`bundle ${bundleName} has mixed global/project child activations; extract independently managed resources or normalize scopes`];
}

function bundleNode(bundleName: string, rows: ResourceDisplayRow[], context: "global" | "project"): BundleDisplayNode {
  const childResources = [...rows].sort(compareResourceDisplayRows);
  const atomicExtensionPackage = childResources.length === 1 && childResources[0]?.type === "extension"
    ? childResources[0].extensionPackage
    : undefined;
  return {
    id: `bundle:${bundleName}`,
    kind: "bundle",
    depth: 0,
    type: "bundle",
    name: bundleName,
    use: deriveBundleUse(childResources, context),
    action: deriveBundleAction(childResources),
    children: [
      ...childResources.map((row) => resourceNode(row, 1)),
      ...(atomicExtensionPackage?.containedResources.map((candidate) => containedResourceNode(bundleName, candidate)) ?? []),
    ],
    childResources,
    ...(atomicExtensionPackage ? { extensionPackage: atomicExtensionPackage } : {}),
    warnings: bundleWarnings(bundleName, childResources),
  };
}

export function buildBundleDisplayTree(options: BuildBundleDisplayTreeOptions): BundleDisplayNode[] {
  const rows = buildResourceDisplayRows(options);
  const bundledRows = new Map<string, ResourceDisplayRow[]>();
  const roots: BundleDisplayNode[] = [];

  for (const row of rows) {
    if (row.bundle) {
      const existingRows = bundledRows.get(row.bundle) ?? [];
      existingRows.push(row);
      bundledRows.set(row.bundle, existingRows);
    } else {
      roots.push(resourceNode(row, 0));
    }
  }

  for (const [bundleName, bundleRows] of bundledRows) {
    roots.push(bundleNode(bundleName, bundleRows, options.context));
  }

  return roots.sort(compareBundleDisplayNodes);
}

export function flattenBundleDisplayTree(tree: BundleDisplayNode[], options: { details: boolean }): BundleDisplayNode[] {
  if (!options.details) return [...tree];

  const flattened: BundleDisplayNode[] = [];
  for (const node of tree) {
    flattened.push(node);
    if (node.children) flattened.push(...node.children);
  }
  return flattened;
}
