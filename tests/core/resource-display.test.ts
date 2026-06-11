import { describe, expect, it } from "vitest";
import { actionForUse, activationUse, buildResourceDisplayRows } from "../../src/core/resource-display.js";
import type { ActivationRecord } from "../../src/core/state.js";
import type { LoadedResource, ResourceType } from "../../src/core/types.js";

function resource(type: ResourceType, name: string, scope: "always-on" | "ephemeral" = "ephemeral", bundle?: string): LoadedResource {
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

function activation(type: ResourceType, name: string, target?: string): ActivationRecord {
  const targetPrefix = type === "extension" ? "extensions" : `${type}s`;
  return { type, name, target: target ?? `${targetPrefix}/${name}` };
}

describe("resource display rows", () => {
  it("sorts by display type order and name and derives use/action", () => {
    const rows = buildResourceDisplayRows({
      resources: [
        resource("prompt", "cleanup"),
        resource("skill", "using-superpowers"),
        resource("skill", "brainstorming"),
        resource("extension", "pi-ephemeral", "always-on"),
        resource("theme", "dark"),
      ],
      globalActivations: [activation("skill", "using-superpowers")],
      projectActivations: [activation("prompt", "cleanup", ".pi/prompts/cleanup")],
      context: "project",
    });

    expect(rows.map((row) => ({ use: row.use, type: row.type, name: row.name, action: row.action }))).toEqual([
      { use: "always", type: "extension", name: "pi-ephemeral", action: "" },
      { use: "", type: "skill", name: "brainstorming", action: "enable" },
      { use: "global", type: "skill", name: "using-superpowers", action: "" },
      { use: "project", type: "prompt", name: "cleanup", action: "disable" },
      { use: "", type: "theme", name: "dark", action: "enable" },
    ]);
    expect(rows.map((row) => row.use)).not.toContain("global+project");
  });

  it("supports global context disables and project promotion", () => {
    expect(actionForUse("global", "global")).toBe("disable");
    expect(actionForUse("project", "global")).toBe("enable");
    expect(actionForUse("project", "project")).toBe("disable");
    expect(actionForUse("always", "global")).toBe("");
  });

  it("uses project activation as effective use for overlaps in project context", () => {
    const shared = resource("skill", "shared");
    const globalIds = new Set([shared.identity]);
    const projectIds = new Set([shared.identity]);

    expect(activationUse(shared, globalIds, projectIds, "project")).toBe("project");
    expect(activationUse(shared, globalIds, projectIds, "global")).toBe("global");

    const projectRows = buildResourceDisplayRows({ resources: [shared], globalActivations: [activation("skill", "shared")], projectActivations: [activation("skill", "shared", ".pi/skills/shared")], context: "project" });
    expect(projectRows[0]).toMatchObject({ use: "project", action: "disable" });
  });

  it("carries bundle metadata from catalog records", () => {
    const rows = buildResourceDisplayRows({
      resources: [resource("skill", "librarian", "ephemeral", "pi-web-access")],
      globalActivations: [],
      projectActivations: [],
      context: "project",
    });

    expect(rows[0]?.bundle).toBe("pi-web-access");
  });
});
