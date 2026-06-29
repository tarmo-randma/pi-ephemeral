#!/usr/bin/env node
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPlan } from "./core/apply.js";
import { loadCatalogSet } from "./core/catalog.js";
import { buildBundleDisplayTree, flattenBundleDisplayTree, type BundleDisplayNode } from "./core/bundles.js";
import { buildResourceDisplayRows, type ResourceDisplayRow } from "./core/resource-display.js";
import { filterBundleDisplayTreeByQuery, searchResourceDisplayRows } from "./core/resource-search.js";
import { formatPlanHuman } from "./core/output.js";
import { globalStatePath, loadProjectIndex, projectStatePath, resolveProjectRoot } from "./core/project-index.js";
import { planDisable, planEnable, planUpdateAll, type OperationPlan } from "./core/planner.js";
import { activationIdentity, readActivationState, StateFileError, type ActivationRecord } from "./core/state.js";
import type { LoadedResource } from "./core/types.js";
import { ArgParseError, HELP_TEXT, parseArgs, type CliCommand } from "./cli/args.js";

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface ResolvedContext {
  packageRoot: string;
  agentDir: string;
  projectRoot: string;
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

async function contextFor(command: Exclude<CliCommand, { command: "help" }>): Promise<ResolvedContext> {
  return {
    packageRoot: command.packageRoot,
    agentDir: command.agentDir ?? defaultAgentDir(),
    projectRoot: await resolveProjectRoot(command.cwd),
  };
}

function sortedActivationsForStatusJson(records: ActivationRecord[]): ActivationRecord[] {
  return [...records].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

interface ResourceDisplayContext {
  catalog: Awaited<ReturnType<typeof loadCatalogSet>>;
  globalActivations: ActivationRecord[];
  projectActivations: ActivationRecord[];
  context: "project";
  warningsByIdentity: Map<string, string[]>;
}

async function loadResourceDisplayContext(ctx: ResolvedContext): Promise<ResourceDisplayContext> {
  const catalog = await loadCatalogSet(ctx.packageRoot);
  const globalState = await readActivationState(globalStatePath(ctx.agentDir), { scope: "global" });
  const projectState = await readActivationState(projectStatePath(ctx.projectRoot), { scope: "project" });
  return {
    catalog,
    globalActivations: globalState.activations,
    projectActivations: projectState.activations,
    context: "project",
    warningsByIdentity: warningsByIdentity(catalog.problems),
  };
}

function bundleTreeForDisplay(display: ResourceDisplayContext): BundleDisplayNode[] {
  return buildBundleDisplayTree({
    resources: display.catalog.resources,
    globalActivations: display.globalActivations,
    projectActivations: display.projectActivations,
    context: display.context,
    warningsByIdentity: display.warningsByIdentity,
  });
}

function resourceProjection(resource: LoadedResource, globalIds: Set<string>, projectIds: Set<string>) {
  return {
    identity: resource.identity,
    type: resource.record.type,
    name: resource.record.name,
    scope: resource.scope,
    path: resource.record.path,
    target: resource.targetPath,
    description: resource.record.description,
    active: {
      global: globalIds.has(resource.identity),
      project: projectIds.has(resource.identity),
    },
  };
}

async function listOutput(command: Extract<CliCommand, { command: "list" }>, ctx: ResolvedContext): Promise<unknown> {
  const display = await loadResourceDisplayContext(ctx);
  const globalIds = new Set(display.globalActivations.map(activationIdentity));
  const projectIds = new Set(display.projectActivations.map(activationIdentity));
  let visibleIds: Set<string> | undefined;
  if (command.filter) {
    const filteredTree = filterBundleDisplayTreeByQuery(bundleTreeForDisplay(display), command.filter, {
      includeBundleChildrenOnBundleMatch: true,
      includeBundleNameForChildren: true,
    });
    visibleIds = new Set(flattenBundleDisplayTree(filteredTree, { details: true }).flatMap((node) => (node.resource ? [node.resource.identity] : [])));
  }
  const resources = display.catalog.resources
    .filter((resource) => !visibleIds || visibleIds.has(resource.identity))
    .map((resource) => resourceProjection(resource, globalIds, projectIds))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  return {
    command: "list",
    ...(command.filter ? { filter: command.filter } : {}),
    packageRoot: ctx.packageRoot,
    projectRoot: ctx.projectRoot,
    agentDir: ctx.agentDir,
    resources,
    problems: display.catalog.problems,
  };
}

async function statusOutput(command: Extract<CliCommand, { command: "status" }>, ctx: ResolvedContext): Promise<unknown> {
  const globalState = await readActivationState(globalStatePath(ctx.agentDir), { scope: "global" });
  const projectState = await readActivationState(projectStatePath(ctx.projectRoot), { scope: "project" });
  const output: Record<string, unknown> = {
    command: "status",
    global: sortedActivationsForStatusJson(globalState.activations),
    project: sortedActivationsForStatusJson(projectState.activations),
    paths: { global: globalStatePath(ctx.agentDir), project: projectStatePath(ctx.projectRoot) },
  };
  if (command.all) {
    const index = await loadProjectIndex(join(ctx.agentDir, "pi-ephemeral-projects.json"));
    output.projects = index.projects;
  }
  return output;
}

interface InfoExactOutput {
  command: "info";
  packageRoot: string;
  projectRoot: string;
  agentDir: string;
  resource: ResourceDisplayRow;
}

interface InfoBundleResult {
  kind: "bundle";
  type: "bundle";
  name: string;
  use: string;
  action: string;
  resources: ResourceDisplayRow[];
  warnings: string[];
}

interface InfoQueryOutput {
  command: "info";
  query: string;
  packageRoot: string;
  projectRoot: string;
  agentDir: string;
  resources: Array<ResourceDisplayRow | InfoBundleResult>;
}

function resourceRowsForDisplay(display: ResourceDisplayContext): ResourceDisplayRow[] {
  return buildResourceDisplayRows({
    resources: display.catalog.resources,
    globalActivations: display.globalActivations,
    projectActivations: display.projectActivations,
    context: display.context,
    warningsByIdentity: display.warningsByIdentity,
  });
}

function bundleInfoResult(node: BundleDisplayNode): InfoBundleResult {
  return {
    kind: "bundle",
    type: "bundle",
    name: node.name,
    use: node.use,
    action: node.action,
    resources: node.childResources ?? [],
    warnings: node.warnings,
  };
}

async function infoOutput(command: Extract<CliCommand, { command: "info" }>, ctx: ResolvedContext): Promise<InfoExactOutput | InfoQueryOutput> {
  const display = await loadResourceDisplayContext(ctx);
  const rows = resourceRowsForDisplay(display);
  if (command.mode === "exact") {
    const matches = rows.filter((row) => row.type === command.type && row.name === command.name);
    if (matches.length === 0) throw new Error(`Unknown resource ${command.type}:${command.name}`);
    return { command: "info", packageRoot: ctx.packageRoot, projectRoot: ctx.projectRoot, agentDir: ctx.agentDir, resource: matches[0]! };
  }

  const search = searchResourceDisplayRows(rows, bundleTreeForDisplay(display), command.query);
  if (search.resourceMatches.length > 0) {
    return { command: "info", query: command.query, packageRoot: ctx.packageRoot, projectRoot: ctx.projectRoot, agentDir: ctx.agentDir, resources: search.resourceMatches };
  }
  if (search.bundleOnlyMatches.length === 1) {
    return { command: "info", query: command.query, packageRoot: ctx.packageRoot, projectRoot: ctx.projectRoot, agentDir: ctx.agentDir, resources: [bundleInfoResult(search.bundleOnlyMatches[0]!)] };
  }
  throw new Error(`No resources match query "${command.query}"`);
}

function warningsByIdentity(problems: Array<{ identity?: string; message: string }>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const problem of problems) {
    for (const identity of problem.identity?.split(",").map((part) => part.trim()).filter(Boolean) ?? []) {
      map.set(identity, [...(map.get(identity) ?? []), problem.message]);
    }
  }
  return map;
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function padded(value: string, width: number): string {
  return truncateCell(value, width).padEnd(width);
}

function table(lines: string[][], widths: number[], maxWidth: number): string[] {
  const totalSeparators = Math.max(0, widths.length - 1) * 2;
  let remaining = Math.max(1, maxWidth - totalSeparators);
  const adjusted = [...widths];
  const fixed = adjusted.reduce((sum, width) => sum + width, 0);
  if (fixed > remaining) {
    for (let i = adjusted.length - 1; i >= 0; i -= 1) {
      const min = i === 2 ? 8 : 4;
      const shrink = Math.min(adjusted[i]! - min, fixed - remaining);
      if (shrink > 0) adjusted[i] = adjusted[i]! - shrink;
      if (adjusted.reduce((sum, width) => sum + width, 0) <= remaining) break;
    }
  }
  remaining = Math.max(1, maxWidth - totalSeparators);
  if (adjusted.reduce((sum, width) => sum + width, 0) > remaining) adjusted[2] = Math.max(1, remaining - adjusted.filter((_, i) => i !== 2).reduce((sum, width) => sum + width, 0));
  return lines.map((cells) => cells.map((cell, index) => padded(cell, adjusted[index] ?? 8)).join("  ").trimEnd());
}

function nodeTypeCell(node: BundleDisplayNode): string {
  return node.depth === 1 ? `  ${node.type}` : node.type;
}

function uniqueBundleWarnings(nodes: BundleDisplayNode[]): string[] {
  return [...new Set(nodes.flatMap((node) => node.warnings))];
}

function listHuman(display: ResourceDisplayContext, width: number, filter?: string): string {
  const tree = bundleTreeForDisplay(display);
  const visibleTree = filter
    ? filterBundleDisplayTreeByQuery(tree, filter, {
        includeBundleChildrenOnBundleMatch: true,
        includeBundleNameForChildren: true,
      })
    : tree;
  const rows = flattenBundleDisplayTree(visibleTree, { details: true });
  const lines = ["Resources:"];
  if (rows.length === 0) lines.push("No matching resources.");
  else lines.push(...table([["Use", "Type", "Name"], ...rows.map((row) => [row.use, nodeTypeCell(row), row.name])], [8, 11, 32], width));
  for (const warning of uniqueBundleWarnings(visibleTree)) lines.push(`WARNING: ${warning}`);
  for (const problem of display.catalog.problems) lines.push(`${problem.severity.toUpperCase()} ${problem.code}: ${problem.message}${problem.path ? ` (${problem.path})` : ""}`);
  return `${lines.join("\n")}\n`;
}

function nodeIsActive(node: BundleDisplayNode): boolean {
  return node.use !== "";
}

function visibleStatusNodes(tree: BundleDisplayNode[]): BundleDisplayNode[] {
  const visible: BundleDisplayNode[] = [];
  for (const node of tree) {
    if (node.kind === "bundle") {
      const activeChildren = (node.children ?? []).filter(nodeIsActive);
      if (activeChildren.length > 0) visible.push(node, ...activeChildren);
    } else if (nodeIsActive(node)) {
      visible.push(node);
    }
  }
  return visible;
}

function statusTarget(node: BundleDisplayNode): string {
  if (node.kind === "bundle") {
    const activeChildren = (node.children ?? []).filter(nodeIsActive);
    return activeChildren[0]?.resource?.target ?? "";
  }
  return node.resource?.target ?? "";
}

function statusHuman(display: ResourceDisplayContext, ctx: ResolvedContext, width: number, projects?: string[]): string {
  const tree = bundleTreeForDisplay(display);
  const rows = visibleStatusNodes(tree);
  const lines = ["Status:", `Global state: ${globalStatePath(ctx.agentDir)}`, `Project state: ${projectStatePath(ctx.projectRoot)}`];
  if (rows.length === 0) lines.push("none");
  else lines.push(...table([["Use", "Type", "Name", "Target"], ...rows.map((row) => [row.use, nodeTypeCell(row), row.name, statusTarget(row)])], [8, 11, 32, 40], width));
  for (const warning of uniqueBundleWarnings(tree)) lines.push(`WARNING: ${warning}`);
  if (projects) lines.push(`Indexed projects: ${projects.length === 0 ? "none" : projects.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function formatInfoPairs(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${key.padEnd(12)}: ${value}`).join("\n");
}

function resourceInfoBlock(row: ResourceDisplayRow): string {
  const warnings = row.warnings.length === 0 ? "none" : row.warnings.join("; ");
  return formatInfoPairs([
    ["Bundle", row.bundle ?? ""],
    ["Type", row.type],
    ["Name", row.name],
    ["Use", row.use],
    ["Action", row.action],
    ["Source", row.source],
    ["Target", row.target],
    ["Description", row.description ?? ""],
    ["Warnings", warnings],
  ]);
}

function bundleInfoBlock(bundle: InfoBundleResult): string {
  const resources = bundle.resources.map((row) => row.identity).join(", ");
  const warnings = bundle.warnings.length === 0 ? "none" : bundle.warnings.join("; ");
  return formatInfoPairs([
    ["Bundle", bundle.name],
    ["Use", bundle.use],
    ["Action", bundle.action],
    ["Resources", resources],
    ["Warnings", warnings],
  ]);
}

function isBundleInfoResult(resource: ResourceDisplayRow | InfoBundleResult): resource is InfoBundleResult {
  return "kind" in resource && resource.kind === "bundle";
}

function infoHuman(output: Awaited<ReturnType<typeof infoOutput>>): string {
  if ("resource" in output) return `${resourceInfoBlock(output.resource)}\n`;
  return `${output.resources.map((resource) => (isBundleInfoResult(resource) ? bundleInfoBlock(resource) : resourceInfoBlock(resource))).join("\n\n")}\n`;
}

async function mutationPlan(command: Extract<CliCommand, { command: "enable" | "disable" | "repair" }>, ctx: ResolvedContext): Promise<OperationPlan> {
  if (command.command === "enable") return planEnable({ ...ctx, scope: command.scope, type: command.type, name: command.name });
  if (command.command === "disable") return planDisable({ ...ctx, scope: command.scope, type: command.type, name: command.name });
  return planUpdateAll(ctx);
}

function errorText(error: unknown): string {
  if (error instanceof StateFileError) return `${error.message} (${error.path})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runCli(argv = process.argv.slice(2), io: CliIO = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  let command: CliCommand;
  try {
    command = parseArgs(argv);
  } catch (error) {
    io.stderr(`${errorText(error)}\n`);
    return error instanceof ArgParseError ? 2 : 1;
  }

  if (command.command === "help") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  try {
    const ctx = await contextFor(command);
    if (command.command === "list") {
      if (command.json) {
        const output = await listOutput(command, ctx);
        io.stdout(`${JSON.stringify(output, null, 2)}\n`);
      } else {
        io.stdout(listHuman(await loadResourceDisplayContext(ctx), command.width, command.filter));
      }
      return 0;
    }
    if (command.command === "status") {
      const output = await statusOutput(command, ctx);
      if (command.json) io.stdout(`${JSON.stringify(output, null, 2)}\n`);
      else {
        const data = output as { projects?: string[] };
        io.stdout(statusHuman(await loadResourceDisplayContext(ctx), ctx, command.width, data.projects));
      }
      return 0;
    }
    if (command.command === "info") {
      const output = await infoOutput(command, ctx);
      io.stdout(command.json ? `${JSON.stringify(output, null, 2)}\n` : infoHuman(output));
      return 0;
    }

    const plan = await mutationPlan(command, ctx);
    const applied = plan.ok ? await applyPlan(plan) : undefined;
    if (command.json) io.stdout(`${JSON.stringify({ command: command.command, plan, applied }, null, 2)}\n`);
    else io.stdout(`${formatPlanHuman(plan)}${applied ? "" : ""}`);
    return plan.ok ? 0 : 1;
  } catch (error) {
    io.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

function isDirectCliInvocation(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return import.meta.url === pathToFileURL(entrypoint).href;
  }
}

if (isDirectCliInvocation()) {
  process.exitCode = await runCli();
}
