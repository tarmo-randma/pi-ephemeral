import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";
import { RESOURCE_TYPES, type ResourceType } from "./types.js";

export interface ActivationRecord {
  type: ResourceType;
  name: string;
  target: string;
}

export interface ActivationState {
  version: 1;
  activations: ActivationRecord[];
}

export type ActivationStateScope = "global" | "project";

export interface ReadActivationStateOptions {
  scope?: ActivationStateScope;
}

export class StateFileError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "StateFileError";
    this.code = code;
    this.path = path;
  }
}

export function emptyActivationState(): ActivationState {
  return { version: 1, activations: [] };
}

function canonicalActivation(record: ActivationRecord): ActivationRecord {
  return { type: record.type, name: record.name, target: record.target };
}

export function normalizeActivationState(state: ActivationState): ActivationState {
  const activations = [...state.activations]
    .map(canonicalActivation)
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { version: 1, activations };
}

export function activationIdentity(record: Pick<ActivationRecord, "type" | "name">): string {
  return `${record.type}:${record.name}`;
}

export function canonicalActivationStateText(state: ActivationState): string {
  return `${JSON.stringify(normalizeActivationState(state), null, 2)}\n`;
}

const GLOBAL_MANAGED_TARGET_PREFIXES = ["extensions/", "skills/", "prompts/", "themes/"] as const;
const PROJECT_MANAGED_TARGET_PREFIXES = GLOBAL_MANAGED_TARGET_PREFIXES.map((prefix) => `.pi/${prefix}`);

function isResourceType(value: string): value is ResourceType {
  return RESOURCE_TYPES.includes(value as ResourceType);
}

function targetPrefixesFor(scope?: ActivationStateScope): readonly string[] {
  if (scope === "global") return GLOBAL_MANAGED_TARGET_PREFIXES;
  if (scope === "project") return PROJECT_MANAGED_TARGET_PREFIXES;
  return [...GLOBAL_MANAGED_TARGET_PREFIXES, ...PROJECT_MANAGED_TARGET_PREFIXES];
}

function assertSafeActivationTarget(target: string, statePath: string, scope?: ActivationStateScope): void {
  const invalid = (reason: string): never => {
    throw new StateFileError("invalid_state", statePath, `Invalid state file ${statePath}: activation target ${JSON.stringify(target)} ${reason}`);
  };
  if (target.length === 0) invalid("must not be empty");
  if (target.includes("\\")) invalid("must not contain backslashes");
  if (isAbsolute(target) || win32.isAbsolute(target)) invalid("must be relative");
  const segments = target.split("/");
  if (segments.some((segment) => segment.length === 0)) invalid("must not contain empty path segments");
  if (segments.includes("..")) invalid("must not contain '..' path traversal");
  if (!targetPrefixesFor(scope).some((prefix) => target.startsWith(prefix))) invalid("must be under a managed target prefix");
}

function parseActivationState(raw: unknown, statePath: string, options: ReadActivationStateOptions = {}): ActivationState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StateFileError("invalid_state", statePath, `Invalid state file ${statePath}: expected object`);
  }
  const candidate = raw as { version?: unknown; activations?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.activations)) {
    throw new StateFileError("invalid_state", statePath, `Invalid state file ${statePath}: expected version 1 activations`);
  }
  const activations: ActivationRecord[] = [];
  for (const item of candidate.activations) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new StateFileError("invalid_state", statePath, `Invalid state file ${statePath}: activation must be object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.type !== "string" || typeof record.name !== "string" || typeof record.target !== "string") {
      throw new StateFileError("invalid_state", statePath, `Invalid state file ${statePath}: activation fields must be strings`);
    }
    if (!isResourceType(record.type)) {
      throw new StateFileError("invalid_state", statePath, `Invalid state file ${statePath}: unsupported activation type ${JSON.stringify(record.type)}`);
    }
    assertSafeActivationTarget(record.target, statePath, options.scope);
    activations.push({ type: record.type, name: record.name, target: record.target });
  }
  return normalizeActivationState({ version: 1, activations });
}

export async function readActivationState(statePath: string, options: ReadActivationStateOptions = {}): Promise<ActivationState> {
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyActivationState();
    throw error;
  }
  try {
    return parseActivationState(JSON.parse(text), statePath, options);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StateFileError("malformed_state_json", statePath, `Malformed JSON in ${statePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function writeActivationState(statePath: string, state: ActivationState): Promise<boolean> {
  const next = canonicalActivationStateText(state);
  try {
    const current = await readFile(statePath, "utf8");
    if (current === next) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, next, "utf8");
  return true;
}

export function upsertActivation(state: ActivationState, activation: ActivationRecord): ActivationState {
  const identity = activationIdentity(activation);
  return normalizeActivationState({
    version: 1,
    activations: [...state.activations.filter((item) => activationIdentity(item) !== identity), activation],
  });
}

export function removeActivation(state: ActivationState, type: ResourceType, name: string): { state: ActivationState; removed?: ActivationRecord } {
  const identity = `${type}:${name}`;
  const removed = state.activations.find((item) => activationIdentity(item) === identity);
  return {
    state: normalizeActivationState({ version: 1, activations: state.activations.filter((item) => activationIdentity(item) !== identity) }),
    removed,
  };
}
