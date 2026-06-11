import { describe, expect, it } from "vitest";
import { buildBundleDisplayTree, flattenBundleDisplayTree } from "../../src/core/bundles.js";
import type { ActivationRecord } from "../../src/core/state.js";
import type { LoadedResource, ResourceType } from "../../src/core/types.js";

function resource(type: ResourceType, name: string, bundle?: string, scope: "always-on" | "ephemeral" = "ephemeral"): LoadedResource {
  const targetPrefix = type === "extension" ? "extensions" : `${type}s`;
  return {
    identity: `${type}:${name}`,
    scope,
    catalogPath: scope === "always-on" ? "resources.json" : "ephemeral/resources.json",
    targetPath: `${targetPrefix}/${name}`,
    record: {
      type,
      name,
      path: scope === "always-on" ? `${targetPrefix}/${name}` : `ephemeral/${targetPrefix}/${name}`,
      description: `${name} description`,
      ...(bundle ? { bundle } : {}),
    },
  };
}

function activation(type: ResourceType, name: string): ActivationRecord {
  const targetPrefix = type === "extension" ? "extensions" : `${type}s`;
  return { type, name, target: `${targetPrefix}/${name}` };
}

function bundleRoot(tree: ReturnType<typeof buildBundleDisplayTree>, name = "pi-web-access") {
  const node = tree.find((candidate) => candidate.kind === "bundle" && candidate.name === name);
  expect(node).toBeDefined();
  return node!;
}

describe("bundle display tree", () => {
  it("groups bundled resources under one synthetic root with child rows", () => {
    const tree = buildBundleDisplayTree({
      resources: [resource("skill", "librarian", "pi-web-access"), resource("extension", "pi-web-access", "pi-web-access")],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: "bundle:pi-web-access", kind: "bundle", type: "bundle", depth: 0, name: "pi-web-access" });
    expect(tree[0]?.childResources?.map((row) => row.identity)).toEqual(["extension:pi-web-access", "skill:librarian"]);
    expect(tree[0]?.children?.map((child) => ({ kind: child.kind, depth: child.depth, type: child.type, name: child.name }))).toEqual([
      { kind: "resource", depth: 1, type: "extension", name: "pi-web-access" },
      { kind: "resource", depth: 1, type: "skill", name: "librarian" },
    ]);
  });

  it("keeps unbundled resources at the root level", () => {
    const tree = buildBundleDisplayTree({
      resources: [resource("skill", "librarian", "pi-web-access"), resource("theme", "dark")],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(tree.map((node) => ({ kind: node.kind, type: node.type, name: node.name, depth: node.depth }))).toEqual([
      { kind: "bundle", type: "bundle", name: "pi-web-access", depth: 0 },
      { kind: "resource", type: "theme", name: "dark", depth: 0 },
    ]);
  });

  it("sorts child rows by resource type order and name", () => {
    const tree = buildBundleDisplayTree({
      resources: [
        resource("theme", "dark", "ui-pack"),
        resource("prompt", "cleanup", "ui-pack"),
        resource("skill", "zeta", "ui-pack"),
        resource("extension", "ui-pack", "ui-pack"),
        resource("skill", "alpha", "ui-pack"),
      ],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(bundleRoot(tree, "ui-pack").children?.map((child) => `${child.type}:${child.name}`)).toEqual(["extension:ui-pack", "skill:alpha", "skill:zeta", "prompt:cleanup", "theme:dark"]);
  });

  it("sorts roots with bundles first, then resource type order and name", () => {
    const tree = buildBundleDisplayTree({
      resources: [
        resource("theme", "dark"),
        resource("skill", "zeta"),
        resource("extension", "z-extension"),
        resource("extension", "a-extension"),
        resource("prompt", "cleanup"),
        resource("skill", "librarian", "z-bundle"),
        resource("skill", "helper", "a-bundle"),
      ],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(tree.map((node) => `${node.type}:${node.name}`)).toEqual(["bundle:a-bundle", "bundle:z-bundle", "extension:a-extension", "extension:z-extension", "skill:zeta", "prompt:cleanup", "theme:dark"]);
  });

  it("derives bundle use/action states", () => {
    const bundleResources = [resource("extension", "pi-web-access", "pi-web-access"), resource("skill", "librarian", "pi-web-access")];

    expect(bundleRoot(buildBundleDisplayTree({ resources: bundleResources, globalActivations: [], projectActivations: [], context: "global" }))).toMatchObject({ use: "", action: "enable" });

    expect(bundleRoot(buildBundleDisplayTree({ resources: bundleResources, globalActivations: [activation("extension", "pi-web-access"), activation("skill", "librarian")], projectActivations: [], context: "global" }))).toMatchObject({ use: "global", action: "disable" });

    expect(bundleRoot(buildBundleDisplayTree({ resources: bundleResources, globalActivations: [activation("extension", "pi-web-access")], projectActivations: [], context: "global" }))).toMatchObject({ use: "global*", action: "enable" });

    expect(bundleRoot(buildBundleDisplayTree({ resources: bundleResources, globalActivations: [], projectActivations: [activation("skill", "librarian")], context: "project" }))).toMatchObject({ use: "project*", action: "enable" });

    expect(bundleRoot(buildBundleDisplayTree({ resources: bundleResources, globalActivations: [], projectActivations: [activation("extension", "pi-web-access"), activation("skill", "librarian")], context: "project" }))).toMatchObject({ use: "project", action: "disable" });
  });

  it("emits a warning when bundle children mix global and project activations", () => {
    const tree = buildBundleDisplayTree({
      resources: [resource("extension", "pi-web-access", "pi-web-access"), resource("skill", "librarian", "pi-web-access")],
      globalActivations: [activation("extension", "pi-web-access")],
      projectActivations: [activation("skill", "librarian")],
      context: "project",
    });

    expect(bundleRoot(tree).warnings).toContain("bundle pi-web-access has mixed global/project child activations; extract independently managed resources or normalize scopes");
  });

  it("preserves bundle warnings when flattened in default and detail modes", () => {
    const tree = buildBundleDisplayTree({
      resources: [resource("extension", "pi-web-access", "pi-web-access"), resource("skill", "librarian", "pi-web-access")],
      globalActivations: [activation("extension", "pi-web-access")],
      projectActivations: [activation("skill", "librarian")],
      context: "project",
    });

    expect(flattenBundleDisplayTree(tree, { details: false }).find((node) => node.name === "pi-web-access")?.warnings).toHaveLength(1);
    expect(flattenBundleDisplayTree(tree, { details: true }).find((node) => node.kind === "bundle")?.warnings).toHaveLength(1);
  });

  it("flattens default mode to roots only", () => {
    const tree = buildBundleDisplayTree({
      resources: [resource("extension", "pi-web-access", "pi-web-access"), resource("skill", "librarian", "pi-web-access"), resource("theme", "dark")],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(flattenBundleDisplayTree(tree, { details: false }).map((node) => `${node.depth}:${node.type}:${node.name}`)).toEqual(["0:bundle:pi-web-access", "0:theme:dark"]);
  });

  it("flattens detail mode to roots plus children with child depth one", () => {
    const tree = buildBundleDisplayTree({
      resources: [resource("extension", "pi-web-access", "pi-web-access"), resource("skill", "librarian", "pi-web-access"), resource("theme", "dark")],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(flattenBundleDisplayTree(tree, { details: true }).map((node) => `${node.depth}:${node.type}:${node.name}`)).toEqual(["0:bundle:pi-web-access", "1:extension:pi-web-access", "1:skill:librarian", "0:theme:dark"]);
  });
});
