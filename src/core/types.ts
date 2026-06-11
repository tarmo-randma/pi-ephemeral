export const RESOURCE_TYPES = ["skill", "extension", "prompt", "theme"] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type Scope = "always-on" | "global" | "project";
export type CatalogScope = "always-on" | "ephemeral";

export interface ResourceRecord {
  type: ResourceType;
  name: string;
  path: string;
  description?: string;
  bundle?: string;
  infra?: Record<string, unknown>;
}

export interface ResourceCatalogFile {
  version: 1;
  resources: ResourceRecord[];
}

export interface CatalogProblem {
  severity: "warning" | "error";
  code: string;
  message: string;
  identity?: string;
  path?: string;
}

export interface LoadedResource {
  record: ResourceRecord;
  scope: CatalogScope;
  identity: string;
  catalogPath: string;
  targetPath?: string;
}

export interface CatalogSet {
  alwaysOn: LoadedResource[];
  ephemeral: LoadedResource[];
  resources: LoadedResource[];
  problems: CatalogProblem[];
}
