import { lstat, mkdir, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadCatalogSet } from "./catalog.js";
import { globalStatePath, hasProjectState, loadProjectIndex, projectExists, projectIndexPath, projectStatePath } from "./project-index.js";
import { activationIdentity, readActivationState, removeActivation, upsertActivation, type ActivationRecord, type ActivationState } from "./state.js";
import type { CatalogProblem, LoadedResource, ResourceType } from "./types.js";

export type PlanScope = "global" | "project" | "mixed";
export type PlanAction =
  | "create_symlink"
  | "recreate_symlink"
  | "remove_symlink"
  | "write_state"
  | "write_project_index"
  | "noop"
  | "prune_project_activation";

export interface PlanMessage {
  code: string;
  message: string;
  identity?: string;
  path?: string;
}

export interface PlanChange {
  action: PlanAction;
  scope: "global" | "project";
  path?: string;
  source?: string;
  statePath?: string;
  state?: ActivationState;
  indexPath?: string;
  projects?: string[];
  identity?: string;
  message: string;
}

export interface PlanActivationSnapshot {
  scope: "global" | "project";
  statePath: string;
  projectRoot?: string;
  activations: ActivationRecord[];
}

export interface OperationPlan {
  ok: boolean;
  scope: PlanScope;
  changes: PlanChange[];
  warnings: PlanMessage[];
  errors: PlanMessage[];
  reloadRecommended: boolean;
  activations?: PlanActivationSnapshot[];
}

export interface PlannerContext {
  packageRoot: string;
  agentDir: string;
  projectRoot: string;
}

export interface ScopedResourceRequest extends PlannerContext {
  scope: "global" | "project";
  type: ResourceType;
  name: string;
}

function msg(problem: CatalogProblem): PlanMessage {
  return { code: problem.code, message: problem.message, identity: problem.identity, path: problem.path };
}

function plan(scope: PlanScope, changes: PlanChange[], warnings: PlanMessage[] = [], errors: PlanMessage[] = [], activations?: PlanActivationSnapshot[]): OperationPlan {
  return { ok: errors.length === 0, scope, changes: errors.length === 0 ? changes : [], warnings, errors, reloadRecommended: errors.length === 0 && changes.length > 0, ...(activations ? { activations } : {}) };
}

function identity(type: ResourceType, name: string): string {
  return `${type}:${name}`;
}

function targetFor(scope: "global" | "project", targetPath: string): string {
  return scope === "global" ? targetPath : join(".pi", targetPath);
}

function targetRoot(ctx: PlannerContext, scope: "global" | "project"): string {
  return scope === "global" ? ctx.agentDir : ctx.projectRoot;
}

function statePath(ctx: PlannerContext, scope: "global" | "project"): string {
  return scope === "global" ? globalStatePath(ctx.agentDir) : projectStatePath(ctx.projectRoot);
}

async function ensureParentFor(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function existingSymlinkTarget(path: string): Promise<string | undefined> {
  try {
    const st = await lstat(path);
    if (!st.isSymbolicLink()) return undefined;
    return await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function symlinkChange(action: "create_symlink" | "recreate_symlink", scope: "global" | "project", path: string, source: string, identityValue: string): Promise<PlanChange | PlanMessage | undefined> {
  const current = await existingSymlinkTarget(path);
  if (current === undefined) return { code: "unmanaged_target", message: `Target exists and is not managed: ${path}`, identity: identityValue, path };
  const sourceAbs = resolve(source);
  if (current !== "missing" && resolve(dirname(path), current) === sourceAbs) return undefined;
  return { action: current === "missing" ? "create_symlink" : action, scope, path, source: sourceAbs, identity: identityValue, message: `${current === "missing" ? "Create" : "Recreate"} symlink ${path}` };
}

async function findResource(ctx: PlannerContext, type: ResourceType, name: string): Promise<{ resource?: LoadedResource; warnings: PlanMessage[]; errors: PlanMessage[] }> {
  const requested = identity(type, name);
  const catalog = await loadCatalogSet(ctx.packageRoot);
  const resource = catalog.ephemeral.find((item) => item.identity === requested);
  const target = resource?.targetPath;
  const warnings = catalog.problems.filter((problem) => {
    if (problem.severity !== "warning") return false;
    if (problem.identity?.split(",").map((item) => item.trim()).includes(requested)) return true;
    if (target && problem.path === target) return true;
    return false;
  }).map(msg);
  const affectedErrors = catalog.problems.filter((problem) => {
    if (problem.severity !== "error") return false;
    if (problem.identity?.split(",").includes(requested) || problem.identity === requested) return true;
    if (problem.identity?.split(",").map((item) => item.trim()).includes(requested)) return true;
    if (target && problem.path === target) return true;
    return false;
  }).map(msg);
  if (!resource && affectedErrors.length === 0) affectedErrors.push({ code: "missing_resource", message: `Resource ${requested} is not in the ephemeral catalog`, identity: requested });
  if (catalog.alwaysOn.some((item) => item.identity === requested)) affectedErrors.push({ code: "always_on", message: `${requested} is always-on and cannot be activated`, identity: requested });
  return { resource, warnings, errors: affectedErrors };
}

async function writeStateChange(scope: "global" | "project", statePathValue: string, nextState: ActivationState, message: string, identityValue: string): Promise<PlanChange> {
  return { action: "write_state", scope, statePath: statePathValue, state: nextState, identity: identityValue, message };
}

async function enableInScope(ctx: PlannerContext, scope: "global" | "project", resource: LoadedResource): Promise<{ changes: PlanChange[]; errors: PlanMessage[] }> {
  const changes: PlanChange[] = [];
  const errors: PlanMessage[] = [];
  const targetPath = targetFor(scope, resource.targetPath!);
  const targetAbs = join(targetRoot(ctx, scope), targetPath);
  const sourceAbs = resolve(ctx.packageRoot, resource.record.path);
  const link = await symlinkChange("recreate_symlink", scope, targetAbs, sourceAbs, resource.identity);
  if (link && "code" in link) errors.push(link);
  else if (link) changes.push(link);
  const currentState = await readActivationState(statePath(ctx, scope), { scope });
  const next = upsertActivation(currentState, { type: resource.record.type, name: resource.record.name, target: targetPath });
  if (JSON.stringify(currentState) !== JSON.stringify(next)) changes.push(await writeStateChange(scope, statePath(ctx, scope), next, `Record activation ${resource.identity}`, resource.identity));
  return { changes, errors };
}

export async function planEnable(request: ScopedResourceRequest): Promise<OperationPlan> {
  const found = await findResource(request, request.type, request.name);
  if (found.errors.length > 0 || !found.resource?.targetPath) return plan(request.scope, [], found.warnings, found.errors);
  const requested = identity(request.type, request.name);

  const globalState = await readActivationState(globalStatePath(request.agentDir), { scope: "global" });
  if (request.scope === "project" && globalState.activations.some((item) => activationIdentity(item) === requested)) {
    return plan("project", [], [{ code: "already_global", message: `${requested} is already globally enabled. No project activation created.`, identity: requested }]);
  }

  const enabled = await enableInScope(request, request.scope, found.resource);
  const changes = [...enabled.changes];
  const errors = [...enabled.errors];
  const indexPath = projectIndexPath(request.agentDir);
  if (request.scope === "project" && errors.length === 0) {
    const index = await loadProjectIndex(indexPath);
    if (!index.projects.includes(request.projectRoot)) changes.push({ action: "write_project_index", scope: "project", indexPath, projects: [...index.projects, request.projectRoot], identity: requested, message: `Index project ${request.projectRoot}` });
  }
  if (request.scope === "global" && errors.length === 0) {
    const index = await loadProjectIndex(indexPath);
    const keptProjects: string[] = [];
    for (const projectRoot of index.projects) {
      const projectStatePathValue = projectStatePath(projectRoot);
      const projectState = await readActivationState(projectStatePathValue, { scope: "project" });
      const removed = removeActivation(projectState, request.type, request.name);
      if (removed.removed) {
        changes.push({ action: "remove_symlink", scope: "project", path: join(projectRoot, removed.removed.target), identity: requested, message: `Remove project symlink ${removed.removed.target}` });
        changes.push({ action: "prune_project_activation", scope: "project", statePath: projectStatePathValue, state: removed.state, identity: requested, message: `Prune project activation ${requested}` });
      }
      if (removed.state.activations.length > 0) keptProjects.push(projectRoot);
    }
    if (JSON.stringify(index.projects.sort()) !== JSON.stringify(keptProjects.sort())) changes.push({ action: "write_project_index", scope: "project", indexPath, projects: keptProjects, identity: requested, message: "Prune promoted project activations from index" });
  }
  return plan(request.scope, changes, found.warnings, errors);
}

export async function planDisable(request: ScopedResourceRequest): Promise<OperationPlan> {
  const statePathValue = statePath(request, request.scope);
  const current = await readActivationState(statePathValue, { scope: request.scope });
  const removed = removeActivation(current, request.type, request.name);
  if (!removed.removed) return plan(request.scope, [], [{ code: "not_managed", message: `${identity(request.type, request.name)} is not active in ${request.scope}`, identity: identity(request.type, request.name) }]);
  const changes: PlanChange[] = [
    { action: "remove_symlink", scope: request.scope, path: join(targetRoot(request, request.scope), removed.removed.target), identity: identity(request.type, request.name), message: `Remove symlink ${removed.removed.target}` },
    { action: "write_state", scope: request.scope, statePath: statePathValue, state: removed.state, identity: identity(request.type, request.name), message: `Remove activation ${identity(request.type, request.name)}` },
  ];
  if (request.scope === "project" && removed.state.activations.length === 0) {
    const index = await loadProjectIndex(projectIndexPath(request.agentDir));
    changes.push({ action: "write_project_index", scope: "project", indexPath: projectIndexPath(request.agentDir), projects: index.projects.filter((project) => project !== request.projectRoot), identity: identity(request.type, request.name), message: `Remove project ${request.projectRoot} from index` });
  }
  return plan(request.scope, changes);
}

async function refreshActivation(ctx: PlannerContext, scope: "global" | "project", activation: ActivationRecord): Promise<{ changes: PlanChange[]; warnings: PlanMessage[]; errors: PlanMessage[]; next?: ActivationRecord }> {
  const found = await findResource(ctx, activation.type, activation.name);
  if (found.errors.length > 0 || !found.resource?.targetPath) return { changes: [], warnings: [...found.warnings, ...found.errors.map((e) => ({ ...e, code: `skipped_${e.code}` }))], errors: [] };
  const expectedTarget = targetFor(scope, found.resource.targetPath);
  const currentTargetAbs = join(targetRoot(ctx, scope), activation.target);
  const expectedTargetAbs = join(targetRoot(ctx, scope), expectedTarget);
  const sourceAbs = resolve(ctx.packageRoot, found.resource.record.path);
  const changes: PlanChange[] = [];
  if (activation.target !== expectedTarget) {
    changes.push({ action: "remove_symlink", scope, path: currentTargetAbs, identity: activationIdentity(activation), message: `Remove old symlink ${activation.target}` });
  }
  const link = await symlinkChange("recreate_symlink", scope, expectedTargetAbs, sourceAbs, activationIdentity(activation));
  if (link && "code" in link) return { changes: [], warnings: found.warnings, errors: [link] };
  if (link) changes.push(link);
  return { changes, warnings: found.warnings, errors: [], next: { ...activation, target: expectedTarget } };
}

async function updateGlobalActivations(ctx: PlannerContext, requested?: { type: ResourceType; name: string }): Promise<{ changes: PlanChange[]; warnings: PlanMessage[]; errors: PlanMessage[]; state: ActivationState; statePath: string }> {
  const changes: PlanChange[] = [];
  const warnings: PlanMessage[] = [];
  const errors: PlanMessage[] = [];
  const globalPath = globalStatePath(ctx.agentDir);
  const globalState = await readActivationState(globalPath, { scope: "global" });
  const requestedId = requested ? identity(requested.type, requested.name) : undefined;
  const nextGlobal: ActivationRecord[] = [];
  for (const activation of globalState.activations) {
    if (requestedId && activationIdentity(activation) !== requestedId) {
      nextGlobal.push(activation);
      continue;
    }
    const refreshed = await refreshActivation(ctx, "global", activation);
    changes.push(...refreshed.changes);
    warnings.push(...refreshed.warnings);
    errors.push(...refreshed.errors);
    nextGlobal.push(refreshed.next ?? activation);
  }
  const normalizedGlobal: ActivationState = { version: 1, ...(globalState.packageRoot ? { packageRoot: globalState.packageRoot } : {}), activations: nextGlobal };
  if (JSON.stringify(globalState) !== JSON.stringify(normalizedGlobal)) {
    changes.push({ action: "write_state", scope: "global", statePath: globalPath, state: normalizedGlobal, identity: requestedId, message: requestedId ? `Update global activation state for ${requestedId}` : "Update global activation state" });
  }
  return { changes, warnings, errors, state: normalizedGlobal, statePath: globalPath };
}

async function updateProjectActivations(ctx: PlannerContext, projectRoot: string, requested?: { type: ResourceType; name: string }, globalActivations: ActivationRecord[] = []): Promise<{ changes: PlanChange[]; warnings: PlanMessage[]; errors: PlanMessage[]; state: ActivationState; statePath: string }> {
  const changes: PlanChange[] = [];
  const warnings: PlanMessage[] = [];
  const errors: PlanMessage[] = [];
  const pStatePath = projectStatePath(projectRoot);
  const projectState = await readActivationState(pStatePath, { scope: "project" });
  const requestedId = requested ? identity(requested.type, requested.name) : undefined;
  const globalIds = new Set(globalActivations.map(activationIdentity));
  let currentProjectState: ActivationState = projectState;
  if (!requestedId) {
    for (const globalActivation of globalActivations) {
      const removed = removeActivation(currentProjectState, globalActivation.type, globalActivation.name);
      if (removed.removed) {
        changes.push({ action: "remove_symlink", scope: "project", path: join(projectRoot, removed.removed.target), identity: activationIdentity(removed.removed), message: `Prune globally superseded ${activationIdentity(removed.removed)}` });
        currentProjectState = removed.state;
      }
    }
  }
  const nextProject: ActivationRecord[] = [];
  for (const activation of currentProjectState.activations) {
    const activationId = activationIdentity(activation);
    if (requestedId && activationId !== requestedId) {
      nextProject.push(activation);
      continue;
    }
    if (!requestedId && globalIds.has(activationId)) continue;
    const refreshed = await refreshActivation({ ...ctx, projectRoot }, "project", activation);
    changes.push(...refreshed.changes);
    warnings.push(...refreshed.warnings);
    errors.push(...refreshed.errors);
    nextProject.push(refreshed.next ?? activation);
  }
  const nextProjectState = { version: 1 as const, activations: nextProject };
  if (JSON.stringify(projectState) !== JSON.stringify(nextProjectState)) {
    changes.push({ action: "write_state", scope: "project", statePath: pStatePath, state: nextProjectState, identity: requestedId, message: requestedId ? `Update project activation state for ${requestedId}` : `Update project state ${projectRoot}` });
  }
  return { changes, warnings, errors, state: nextProjectState, statePath: pStatePath };
}

function snapshot(scope: "global" | "project", statePathValue: string, state: ActivationState, projectRoot?: string): PlanActivationSnapshot {
  return { scope, statePath: statePathValue, ...(projectRoot ? { projectRoot } : {}), activations: state.activations };
}

export async function planUpdateGlobal(ctx: PlannerContext): Promise<OperationPlan> {
  const updated = await updateGlobalActivations(ctx);
  return plan("global", updated.changes, updated.warnings, updated.errors, [snapshot("global", updated.statePath, updated.state)]);
}

export async function planUpdateProject(ctx: PlannerContext): Promise<OperationPlan> {
  const updated = await updateProjectActivations(ctx, ctx.projectRoot);
  return plan("project", updated.changes, updated.warnings, updated.errors, [snapshot("project", updated.statePath, updated.state, ctx.projectRoot)]);
}

export async function planUpdateCurrent(ctx: PlannerContext): Promise<OperationPlan> {
  const changes: PlanChange[] = [];
  const warnings: PlanMessage[] = [];
  const errors: PlanMessage[] = [];
  const activations: PlanActivationSnapshot[] = [];

  const global = await updateGlobalActivations(ctx);
  changes.push(...global.changes);
  warnings.push(...global.warnings);
  errors.push(...global.errors);
  activations.push(snapshot("global", global.statePath, global.state));

  const project = await updateProjectActivations(ctx, ctx.projectRoot, undefined, global.state.activations);
  changes.push(...project.changes);
  warnings.push(...project.warnings);
  errors.push(...project.errors);
  activations.push(snapshot("project", project.statePath, project.state, ctx.projectRoot));

  return plan("mixed", changes, warnings, errors, activations);
}

export async function planUpdateTarget(ctx: PlannerContext, type: ResourceType, name: string, scope?: "global" | "project"): Promise<OperationPlan> {
  const changes: PlanChange[] = [];
  const warnings: PlanMessage[] = [];
  const errors: PlanMessage[] = [];
  const activations: PlanActivationSnapshot[] = [];
  if (!scope || scope === "global") {
    const global = await updateGlobalActivations(ctx, { type, name });
    changes.push(...global.changes);
    warnings.push(...global.warnings);
    errors.push(...global.errors);
    activations.push(snapshot("global", global.statePath, global.state));
  }
  if (!scope || scope === "project") {
    const project = await updateProjectActivations(ctx, ctx.projectRoot, { type, name });
    changes.push(...project.changes);
    warnings.push(...project.warnings);
    errors.push(...project.errors);
    activations.push(snapshot("project", project.statePath, project.state, ctx.projectRoot));
  }
  return plan(scope ?? "mixed", changes, warnings, errors, activations);
}

export async function planUpdateAll(ctx: PlannerContext): Promise<OperationPlan> {
  const changes: PlanChange[] = [];
  const warnings: PlanMessage[] = [];
  const errors: PlanMessage[] = [];
  const activations: PlanActivationSnapshot[] = [];

  const global = await updateGlobalActivations(ctx);
  changes.push(...global.changes);
  warnings.push(...global.warnings);
  errors.push(...global.errors);
  activations.push(snapshot("global", global.statePath, global.state));

  const indexPath = projectIndexPath(ctx.agentDir);
  const index = await loadProjectIndex(indexPath);
  const projectSet = new Set(index.projects);

  if (await hasProjectState(ctx.projectRoot)) {
    const currentState = await readActivationState(projectStatePath(ctx.projectRoot), { scope: "project" });
    if (currentState.activations.length > 0) projectSet.add(ctx.projectRoot);
  }

  const keptProjects: string[] = [];
  for (const projectRoot of [...projectSet].sort()) {
    if (!(await projectExists(projectRoot))) continue;
    if (!(await hasProjectState(projectRoot))) continue;
    const project = await updateProjectActivations(ctx, projectRoot, undefined, global.state.activations);
    changes.push(...project.changes);
    warnings.push(...project.warnings);
    errors.push(...project.errors);
    activations.push(snapshot("project", project.statePath, project.state, projectRoot));
    if (project.state.activations.length > 0) keptProjects.push(projectRoot);
  }
  if (JSON.stringify([...index.projects].sort()) !== JSON.stringify([...keptProjects].sort())) changes.push({ action: "write_project_index", scope: "project", indexPath, projects: keptProjects, message: "Prune stale project index entries" });
  return plan("mixed", changes, warnings, errors, activations);
}

export async function planUpdateTargetAll(ctx: PlannerContext, type: ResourceType, name: string): Promise<OperationPlan> {
  const changes: PlanChange[] = [];
  const warnings: PlanMessage[] = [];
  const errors: PlanMessage[] = [];
  const activations: PlanActivationSnapshot[] = [];
  const requested = { type, name };

  const global = await updateGlobalActivations(ctx, requested);
  changes.push(...global.changes);
  warnings.push(...global.warnings);
  errors.push(...global.errors);
  activations.push(snapshot("global", global.statePath, global.state));

  const indexPath = projectIndexPath(ctx.agentDir);
  const index = await loadProjectIndex(indexPath);
  const keptProjects: string[] = [];
  for (const projectRoot of index.projects) {
    if (!(await projectExists(projectRoot))) continue;
    const project = await updateProjectActivations(ctx, projectRoot, requested);
    changes.push(...project.changes);
    warnings.push(...project.warnings);
    errors.push(...project.errors);
    activations.push(snapshot("project", project.statePath, project.state, projectRoot));
    if (project.state.activations.length > 0) keptProjects.push(projectRoot);
  }
  if (JSON.stringify([...index.projects].sort()) !== JSON.stringify([...keptProjects].sort())) changes.push({ action: "write_project_index", scope: "project", indexPath, projects: keptProjects, identity: identity(type, name), message: "Prune stale project index entries" });
  return plan("mixed", changes, warnings, errors, activations);
}

export { ensureParentFor };
