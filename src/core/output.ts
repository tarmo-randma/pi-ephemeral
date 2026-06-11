import type { ApplyResult } from "./apply.js";
import type { OperationPlan } from "./planner.js";

export interface OperationProjection {
  plan: OperationPlan;
  applied?: ApplyResult;
}

export function toJsonOutput(projection: OperationProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

export function formatPlanHuman(plan: OperationPlan): string {
  const lines: string[] = [];
  lines.push(plan.ok ? "Plan OK" : "Plan failed");
  for (const error of plan.errors) lines.push(`ERROR ${error.code}: ${error.message}${error.path ? ` (${error.path})` : ""}`);
  for (const warning of plan.warnings) lines.push(`WARN ${warning.code}: ${warning.message}${warning.path ? ` (${warning.path})` : ""}`);
  for (const change of plan.changes) lines.push(`${change.action}: ${change.message}`);
  if (plan.reloadRecommended) lines.push("Reload recommended: run /reload");
  return `${lines.join("\n")}\n`;
}

export function formatApplyHuman(result: ApplyResult): string {
  if (result.applied.length === 0) return "No changes applied.\n";
  return `${result.applied.map((change) => `applied ${change.action}: ${change.message}`).join("\n")}\n`;
}
