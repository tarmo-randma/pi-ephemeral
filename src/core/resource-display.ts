import type { ActivationRecord } from "./state.js";
import { activationIdentity } from "./state.js";
import type { LoadedResource, ResourceType } from "./types.js";

export const RESOURCE_TYPE_DISPLAY_ORDER: readonly ResourceType[] = ["extension", "skill", "prompt", "theme"] as const;
export type ResourceUse = "" | "always" | "global" | "project";
export type ResourceAction = "" | "enable" | "disable";

export interface ResourceDisplayRow {
  identity: string;
  type: ResourceType;
  name: string;
  bundle?: string;
  use: ResourceUse;
  action: ResourceAction;
  source: string;
  target: string;
  description?: string;
  warnings: string[];
}

export interface BuildResourceDisplayRowsOptions {
  resources: LoadedResource[];
  globalActivations: ActivationRecord[];
  projectActivations: ActivationRecord[];
  context: "global" | "project";
  warningsByIdentity?: Map<string, string[]>;
}

function typeOrder(type: ResourceType): number {
  const index = RESOURCE_TYPE_DISPLAY_ORDER.indexOf(type);
  return index === -1 ? RESOURCE_TYPE_DISPLAY_ORDER.length : index;
}

export function compareResourceDisplayRows(a: Pick<ResourceDisplayRow, "type" | "name">, b: Pick<ResourceDisplayRow, "type" | "name">): number {
  return typeOrder(a.type) - typeOrder(b.type) || a.name.localeCompare(b.name);
}

export function activationUse(resource: LoadedResource, globalIds: Set<string>, projectIds: Set<string>, context: "global" | "project"): ResourceUse {
  if (resource.scope === "always-on") return "always";
  if (context === "project" && projectIds.has(resource.identity)) return "project";
  if (globalIds.has(resource.identity)) return "global";
  if (projectIds.has(resource.identity)) return "project";
  return "";
}

export function actionForUse(use: ResourceUse, context: "global" | "project"): ResourceAction {
  if (use === "always") return "";
  if (use === "") return "enable";
  if (use === "project") return context === "project" ? "disable" : "enable";
  if (use === "global") return context === "global" ? "disable" : "";
  return "";
}

export function buildResourceDisplayRows(options: BuildResourceDisplayRowsOptions): ResourceDisplayRow[] {
  const globalIds = new Set(options.globalActivations.map(activationIdentity));
  const projectIds = new Set(options.projectActivations.map(activationIdentity));
  return options.resources
    .map((resource) => {
      const use = activationUse(resource, globalIds, projectIds, options.context);
      const warnings = options.warningsByIdentity?.get(resource.identity) ?? [];
      return {
        identity: resource.identity,
        type: resource.record.type,
        name: resource.record.name,
        ...(resource.record.bundle ? { bundle: resource.record.bundle } : {}),
        use,
        action: actionForUse(use, options.context),
        source: resource.record.path,
        target: resource.targetPath ?? "",
        ...(resource.record.description ? { description: resource.record.description } : {}),
        warnings,
      } satisfies ResourceDisplayRow;
    })
    .sort(compareResourceDisplayRows);
}
