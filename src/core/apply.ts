import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeActivationState } from "./state.js";
import { updateProjectIndex } from "./project-index.js";
import type { OperationPlan, PlanChange } from "./planner.js";

export interface ApplyResult {
  applied: PlanChange[];
}

async function removeManagedSymlink(path: string): Promise<void> {
  try {
    await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "EINVAL") return;
    throw error;
  }
  await rm(path);
}

async function createSymlink(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const current = await readlink(path);
    if (resolve(dirname(path), current) === resolve(source)) return;
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
    if ((error as NodeJS.ErrnoException).code === "EINVAL") throw new Error(`Target exists and is not a symlink: ${path}`);
  }
  await symlink(resolve(source), path);
}

export async function applyPlan(plan: OperationPlan): Promise<ApplyResult> {
  if (!plan.ok) throw new Error("Cannot apply a plan that is not ok");
  const applied: PlanChange[] = [];
  for (const change of plan.changes) {
    if (change.action === "create_symlink" || change.action === "recreate_symlink") {
      if (!change.path || !change.source) throw new Error(`Invalid symlink change: ${change.message}`);
      await createSymlink(change.path, change.source);
    } else if (change.action === "remove_symlink") {
      if (!change.path) throw new Error(`Invalid remove change: ${change.message}`);
      await removeManagedSymlink(change.path);
    } else if (change.action === "write_state" || change.action === "prune_project_activation") {
      if (!change.statePath || !change.state) throw new Error(`Invalid state change: ${change.message}`);
      await writeActivationState(change.statePath, change.state);
    } else if (change.action === "write_project_index") {
      if (!change.indexPath || !change.projects) throw new Error(`Invalid project index change: ${change.message}`);
      await updateProjectIndex(change.indexPath, change.projects);
    } else if (change.action === "noop") {
      // No operation.
    }
    applied.push(change);
  }
  return { applied };
}
