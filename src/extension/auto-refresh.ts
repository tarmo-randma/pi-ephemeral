import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPlan } from "../core/apply.js";
import { planUpdateGlobal, planUpdateProject, type OperationPlan } from "../core/planner.js";
import { resolveProjectRoot } from "../core/project-index.js";
import { formatPlanHuman } from "../core/output.js";

export interface AutoRefreshRuntimeContext {
  packageRoot: string;
  agentDir?: string;
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

function notifyPlanWarnings(ctx: Pick<ExtensionContext, "ui">, plan: OperationPlan): void {
  for (const warning of plan.warnings) ctx.ui.notify(`pi-ephemeral refresh: ${warning.message}`, "warning");
  for (const error of plan.errors) ctx.ui.notify(`pi-ephemeral refresh: ${error.message}`, "warning");
}

export async function refreshOnResourcesDiscover(event: { cwd: string; reason: string }, ctx: Pick<ExtensionContext, "cwd" | "ui">, runtime: AutoRefreshRuntimeContext): Promise<{ skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] } | undefined> {
  if (event.reason !== "startup" && event.reason !== "reload") return undefined;
  try {
    const baseCtx = {
      packageRoot: runtime.packageRoot,
      agentDir: runtime.agentDir ?? defaultAgentDir(),
      projectRoot: await resolveProjectRoot(event.cwd || ctx.cwd),
    };
    const globalPlan = await planUpdateGlobal(baseCtx);
    notifyPlanWarnings(ctx, globalPlan);
    if (globalPlan.ok) await applyPlan(globalPlan);

    const projectPlan = await planUpdateProject(baseCtx);
    notifyPlanWarnings(ctx, projectPlan);
    if (projectPlan.ok) await applyPlan(projectPlan);
    if (!globalPlan.ok || !projectPlan.ok) {
      ctx.ui.notify(`pi-ephemeral refresh did not apply all changes.\n${formatPlanHuman(globalPlan)}${formatPlanHuman(projectPlan)}`.trim(), "warning");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-ephemeral refresh skipped: ${message}`, "warning");
  }
  return undefined;
}
