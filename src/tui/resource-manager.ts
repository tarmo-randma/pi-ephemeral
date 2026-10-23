import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, SelectList, Text, TruncatedText, decodeKittyPrintable, matchesKey, truncateToWidth, type Component, type KeybindingsManager, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import { applyPlan } from "../core/apply.js";
import { loadCatalogSet } from "../core/catalog.js";
import { globalStatePath, projectStatePath } from "../core/project-index.js";
import { planDisable, planEnable, type OperationPlan, type PlanChange, type PlanMessage, type PlannerContext } from "../core/planner.js";
import { buildBundleDisplayTree, flattenBundleDisplayTree, type BundleAction, type BundleUse, type RootDisplayType } from "../core/bundles.js";
import { compareResourceDisplayRows } from "../core/resource-display.js";
import { filterBundleDisplayTreeByQuery, normalizeResourceQuery } from "../core/resource-search.js";
import { activationIdentity, readActivationState, type ActivationState } from "../core/state.js";
import { type CatalogSet, type LoadedResource, type ResourceType } from "../core/types.js";

export type ResourceManagerScope = "global" | "project";

export interface PendingResourceToggle {
  type: ResourceType;
  name: string;
  scope: ResourceManagerScope;
  enabled: boolean;
}

export interface ResourceManagerViewModelInput {
  catalog: CatalogSet;
  globalState: ActivationState;
  projectState: ActivationState;
  selectedScope: ResourceManagerScope;
  details: boolean;
  pending: PendingResourceToggle[];
  search?: string;
}

export interface ResourceManagerRow {
  identity: string;
  kind: "bundle" | "resource" | "contained-resource";
  depth: 0 | 1;
  type: RootDisplayType;
  name: string;
  description?: string;
  use: BundleUse;
  action: BundleAction;
  active: boolean;
  globalActive: boolean;
  projectActive: boolean;
  alwaysOn: boolean;
  editable: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
  usageCount: number;
  pending: boolean;
  pendingEnabled?: boolean;
  warnings: string[];
  muted: boolean;
  childResources?: { type: ResourceType; name: string; identity: string; action: BundleAction }[];
}

export interface ResourceManagerSideEffect {
  action: "prune_project_activation";
  identity: string;
  message: string;
}

export interface ResourceManagerViewModel {
  selectedScope: ResourceManagerScope;
  details: boolean;
  rows: ResourceManagerRow[];
  warnings: PlanMessage[];
  errors: PlanMessage[];
  sideEffects: ResourceManagerSideEffect[];
}

function identity(type: ResourceType, name: string): string {
  return `${type}:${name}`;
}

function activeSet(state: ActivationState): Set<string> {
  return new Set(state.activations.map(activationIdentity));
}

function pendingKey(toggle: Pick<PendingResourceToggle, "type" | "name" | "scope">): string {
  return `${toggle.scope}:${identity(toggle.type, toggle.name)}`;
}

function latestPending(pending: PendingResourceToggle[]): Map<string, PendingResourceToggle> {
  const map = new Map<string, PendingResourceToggle>();
  for (const toggle of pending) map.set(pendingKey(toggle), toggle);
  return map;
}

function catalogWarningMessages(catalog: CatalogSet): PlanMessage[] {
  return catalog.problems.filter((problem) => problem.severity === "warning").map((problem) => ({ code: problem.code, message: problem.message, identity: problem.identity, path: problem.path }));
}

function catalogErrorMessages(catalog: CatalogSet): PlanMessage[] {
  return catalog.problems.filter((problem) => problem.severity === "error").map((problem) => ({ code: problem.code, message: problem.message, identity: problem.identity, path: problem.path }));
}

function sortResources(resources: LoadedResource[]): LoadedResource[] {
  return [...resources].sort((a, b) => compareResourceDisplayRows({ type: a.record.type, name: a.record.name }, { type: b.record.type, name: b.record.name }));
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function tableRow(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => truncateCell(cell, widths[index] ?? 8).padEnd(widths[index] ?? 8)).join("  ").trimEnd();
}

function tuiRowWidths(renderWidth: number): readonly number[] {
  const use = 7;
  const type = 11;
  const action = 7;
  const pending = 7;
  const separators = 8;
  const horizontalChrome = 4;
  const available = Math.max(48, renderWidth - horizontalChrome - separators);
  const name = Math.max(16, available - use - type - action - pending);
  return [use, type, name, action, pending] as const;
}

export function buildResourceManagerViewModel(input: ResourceManagerViewModelInput): ResourceManagerViewModel {
  const globalActive = activeSet(input.globalState);
  const projectActive = activeSet(input.projectState);
  const pending = latestPending(input.pending);
  const sideEffects: ResourceManagerSideEffect[] = [];
  const warnings = catalogWarningMessages(input.catalog);
  const errors = catalogErrorMessages(input.catalog);
  const search = normalizeResourceQuery(input.search ?? "");
  const resources = sortResources(input.catalog.resources);

  const effectiveByIdentity = new Map<string, { global: boolean; project: boolean }>();
  const resourceByIdentity = new Map(resources.map((resource) => [resource.identity, resource]));
  for (const resource of resources) {
    const id = resource.identity;
    const alwaysOn = resource.scope === "always-on";
    const globalToggle = pending.get(`global:${id}`);
    const projectToggle = pending.get(`project:${id}`);
    const effectiveGlobal = alwaysOn || (globalToggle ? globalToggle.enabled : globalActive.has(id));
    const effectiveProject = projectToggle ? projectToggle.enabled : projectActive.has(id);
    effectiveByIdentity.set(id, { global: effectiveGlobal, project: effectiveProject });
  }

  for (const resource of resources) {
    const id = resource.identity;
    const selectedToggle = pending.get(`${input.selectedScope}:${id}`);
    if (resource.scope !== "always-on" && input.selectedScope === "global" && selectedToggle?.enabled && projectActive.has(id)) {
      sideEffects.push({ action: "prune_project_activation", identity: id, message: `${id} will be promoted to global and pruned from project state on apply.` });
      warnings.push({ code: "pending_promotion", identity: id, message: `${id} is currently project-enabled; global apply will prune project activation.` });
    }
  }

  const warningsByIdentity = new Map<string, string[]>();
  for (const problem of input.catalog.problems) {
    for (const id of problem.identity?.split(",").map((part) => part.trim()).filter(Boolean) ?? []) {
      warningsByIdentity.set(id, [...(warningsByIdentity.get(id) ?? []), problem.message]);
    }
  }

  const searchActive = Boolean(search);
  const tree = filterBundleDisplayTreeByQuery(buildBundleDisplayTree({
    resources,
    globalActivations: resources
      .filter((resource) => effectiveByIdentity.get(resource.identity)?.global)
      .map((resource) => ({ type: resource.record.type, name: resource.record.name, target: resource.targetPath ?? "" })),
    projectActivations: resources
      .filter((resource) => effectiveByIdentity.get(resource.identity)?.project)
      .map((resource) => ({ type: resource.record.type, name: resource.record.name, target: resource.targetPath ?? "" })),
    context: input.selectedScope,
    warningsByIdentity,
  }), search, { includeBundleChildrenOnBundleMatch: true, includeBundleNameForChildren: true });

  const rows = flattenBundleDisplayTree(tree, { details: input.details || searchActive }).map((node): ResourceManagerRow => {
    const resource = node.resource ? resourceByIdentity.get(node.resource.identity) : undefined;
    const containedResource = node.containedResource;
    const id = node.id;
    const selectedToggle = resource ? pending.get(`${input.selectedScope}:${id}`) : undefined;
    const effective = resource ? (effectiveByIdentity.get(id) ?? { global: false, project: false }) : { global: node.use.startsWith("global"), project: node.use.startsWith("project") };
    const alwaysOn = resource?.scope === "always-on" || node.use.startsWith("always");
    const readOnlyReason = containedResource
      ? `${containedResource.type}:${containedResource.name} is part of extension package ${node.containedIn ?? ""} and is read-only; toggle the package extension instead.`
      : resource && node.action === "" && alwaysOn
        ? "Resource is always-on and cannot be changed here."
        : resource && node.action === "" && input.selectedScope === "project" && effective.global && !effective.project
          ? "Resource is globally enabled; disable it globally to manage project state."
          : undefined;
    const usageCount = resource ? (alwaysOn ? 1 : 0) + (effective.global && !alwaysOn ? 1 : 0) + (effective.project ? 1 : 0) : (node.use ? 1 : 0);
    const active = input.selectedScope === "global" ? effective.global : effective.global || effective.project || node.use !== "";
    return {
      identity: id,
      kind: node.kind,
      depth: node.depth,
      type: node.type,
      name: node.name,
      ...(node.resource?.description ? { description: node.resource.description } : {}),
      use: node.use,
      action: node.action,
      active,
      globalActive: effective.global,
      projectActive: effective.project,
      alwaysOn,
      editable: node.action !== "",
      readOnly: node.action === "",
      ...(readOnlyReason ? { readOnlyReason } : {}),
      usageCount,
      pending: Boolean(selectedToggle),
      ...(selectedToggle ? { pendingEnabled: selectedToggle.enabled } : {}),
      warnings: node.warnings,
      muted: node.kind === "contained-resource",
      ...(node.childResources ? { childResources: node.childResources.map((child) => ({ type: child.type, name: child.name, identity: child.identity, action: child.action })) } : {}),
    };
  });

  return { selectedScope: input.selectedScope, details: input.details, rows, warnings, errors, sideEffects };
}

function emptyPlan(scope: "mixed" | ResourceManagerScope): OperationPlan {
  return { ok: true, scope, changes: [], warnings: [], errors: [], reloadRecommended: false };
}

function mergePlans(scope: "mixed" | ResourceManagerScope, plans: OperationPlan[]): OperationPlan {
  const changes = plans.flatMap((plan) => plan.changes);
  const warnings = plans.flatMap((plan) => plan.warnings);
  const errors = plans.flatMap((plan) => plan.errors);
  return { ok: errors.length === 0, scope, changes: errors.length === 0 ? changes : [], warnings, errors, reloadRecommended: errors.length === 0 && changes.length > 0 };
}

export async function previewPendingResourceChanges(ctx: PlannerContext, pending: PendingResourceToggle[]): Promise<OperationPlan> {
  if (pending.length === 0) return emptyPlan("mixed");
  const plans: OperationPlan[] = [];
  for (const toggle of latestPending(pending).values()) {
    plans.push(toggle.enabled
      ? await planEnable({ ...ctx, scope: toggle.scope, type: toggle.type, name: toggle.name })
      : await planDisable({ ...ctx, scope: toggle.scope, type: toggle.type, name: toggle.name }));
  }
  return mergePlans("mixed", plans);
}

export interface ApplyPendingResourceChangesResult {
  plan: OperationPlan;
}

export async function applyPendingResourceChanges(ctx: PlannerContext, pending: PendingResourceToggle[]): Promise<ApplyPendingResourceChangesResult> {
  const toggles = [...latestPending(pending).values()];
  const appliedPlans: OperationPlan[] = [];
  for (const toggle of toggles) {
    const freshPlan = toggle.enabled
      ? await planEnable({ ...ctx, scope: toggle.scope, type: toggle.type, name: toggle.name })
      : await planDisable({ ...ctx, scope: toggle.scope, type: toggle.type, name: toggle.name });
    if (!freshPlan.ok) return { plan: mergePlans("mixed", [...appliedPlans, freshPlan]) };
    await applyPlan(freshPlan);
    appliedPlans.push(freshPlan);
  }
  return { plan: mergePlans("mixed", appliedPlans) };
}

export type ResourceManagerResult = "applied" | "unchanged" | "cancelled" | "failed";

interface ResourceManagerComponentOptions extends PlannerContext {
  initialScope: ResourceManagerScope;
  done: (result: ResourceManagerResult) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  requestRender: () => void;
  theme: Pick<Theme, "fg" | "bold">;
  selectListTheme?: SelectListTheme;
  terminalRows?: () => number;
  keybindings: KeybindingsManager;
}

const CONTENT_START_COLUMN = 2;

export class ResourceManagerComponent implements Component {
  private container = new Container();
  private catalog?: CatalogSet;
  private globalState?: ActivationState;
  private projectState?: ActivationState;
  private scope: ResourceManagerScope;
  private details = false;
  private pending: PendingResourceToggle[] = [];
  private search = "";
  private searchMode = false;
  private selectedIdentity?: string;
  private selectedIndex = 0;
  private preview: OperationPlan = emptyPlan("mixed");
  private loading = true;
  private error?: string;
  private saving = false;
  private saveFailed = false;
  private status?: string;

  constructor(private readonly options: ResourceManagerComponentOptions) {
    this.scope = options.initialScope;
    void this.refresh();
  }

  invalidate(): void {
    this.container.invalidate();
  }

  private async refresh(): Promise<void> {
    try {
      this.loading = true;
      this.catalog = await loadCatalogSet(this.options.packageRoot);
      this.globalState = await readActivationState(globalStatePath(this.options.agentDir), { scope: "global" });
      this.projectState = await readActivationState(projectStatePath(this.options.projectRoot), { scope: "project" });
      this.preview = await previewPendingResourceChanges(this.options, this.pending);
      this.error = undefined;
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.loading = false;
      this.options.requestRender();
    }
  }

  private viewModel(): ResourceManagerViewModel | undefined {
    if (!this.catalog || !this.globalState || !this.projectState) return undefined;
    return buildResourceManagerViewModel({ catalog: this.catalog, globalState: this.globalState, projectState: this.projectState, selectedScope: this.scope, details: this.details, pending: this.pending, search: this.search });
  }

  render(width: number): string[] {
    this.container.clear();
    const accent = (text: string) => this.options.theme.fg("accent", text);
    const muted = (text: string) => this.options.theme.fg("muted", text);
    const warning = (text: string) => this.options.theme.fg("warning", text);
    const danger = (text: string) => this.options.theme.fg("error", text);
    this.container.addChild(new DynamicBorder((s: string) => accent(s)));
    const target = this.scope === "global" ? globalStatePath(this.options.agentDir) : this.options.projectRoot;
    const scopeLabel = `Scope: ${this.scope}`;
    const headerWidth = Math.max(1, width - CONTENT_START_COLUMN * 2);
    // Keep scope readable before spending the remaining header space on the title and target path.
    const titleWidth = Math.max(0, headerWidth - scopeLabel.length - 6 - Math.min(24, Math.floor(headerWidth / 3)));
    const title = truncateToWidth("Pi Ephemeral Resource Manager", titleWidth);
    this.container.addChild(new TruncatedText(accent(this.options.theme.bold(`${title ? `${title} • ` : ""}${scopeLabel} ${target}`)), CONTENT_START_COLUMN, 0));
    if (this.status) this.container.addChild(new Text(this.status, CONTENT_START_COLUMN, 0));

    if (this.loading) this.container.addChild(new Text("Loading resources…", CONTENT_START_COLUMN, 0));
    else if (this.error) this.container.addChild(new Text(danger(this.error), CONTENT_START_COLUMN, 0));
    else {
      const vm = this.viewModel();
      if (vm) {
        const rowWidths = tuiRowWidths(width);
        this.container.addChild(new TruncatedText(tableRow(["Use", "Type", "Name", "Action", "Pending"], rowWidths), CONTENT_START_COLUMN, 0));
        const items: SelectItem[] = vm.rows.map((row) => {
          const label = tableRow([row.use, `${row.depth === 1 ? "  " : ""}${row.type}`, row.name, row.action, row.pending ? (row.pendingEnabled ? "enable" : "disable") : ""], rowWidths);
          return { value: row.identity, label: row.muted ? muted(label) : label };
        });
        const messages = [...new Set([
          ...vm.rows.flatMap((row) => row.warnings.map((message) => warning(`warning: ${message}`))),
          ...vm.warnings.filter((item) => item.code !== "read_only_catalog").map((item) => warning(`warning: ${item.message}`)),
          ...vm.errors.map((item) => danger(`error: ${item.message}`)),
          ...this.preview.warnings.filter((item) => item.code !== "read_only_catalog").map((item) => warning(`plan warning: ${item.message}`)),
          ...this.preview.errors.map((item) => danger(`plan error: ${item.message}`)),
          ...this.preview.changes.slice(0, 5).map((change) => muted(`change: ${change.message}`)),
        ])];
        if (this.preview.changes.length > 5) messages.push(muted(`change: … ${this.preview.changes.length - 5} more`));
        const messageText = new Text(messages.join("\n"), CONTENT_START_COLUMN, 0);
        const terminalRows = this.options.terminalRows?.();
        // Count the rendered header/status/table and messages; only the footer and bottom border remain.
        const maxVisibleRows = terminalRows === undefined ? (this.details ? 28 : 20)
          : Math.max(1, terminalRows - this.container.render(width).length - messageText.render(width).length - 2);
        const visibleRows = Math.min(Math.max(items.length, 1), maxVisibleRows);
        const list = new SelectList(items, visibleRows, this.options.selectListTheme ?? getSelectListTheme());
        if (items.length > 0) {
          if (this.selectedIdentity) {
            const index = items.findIndex((item) => item.value === this.selectedIdentity);
            this.selectedIndex = index >= 0 ? index : Math.min(this.selectedIndex, items.length - 1);
          } else {
            this.selectedIndex = Math.min(this.selectedIndex, items.length - 1);
          }
          list.setSelectedIndex(this.selectedIndex);
          this.selectedIdentity = items[this.selectedIndex]?.value;
        }
        list.onSelectionChange = (item) => { this.selectedIdentity = item.value; this.selectedIndex = Math.max(0, items.findIndex((candidate) => candidate.value === item.value)); };
        list.onSelect = (item) => { this.selectedIdentity = item.value; void this.toggleSelected(); };
        list.onCancel = () => this.options.done(this.saveFailed ? "failed" : "cancelled");
        // SelectList has no hide-counter option. Its public render returns item rows followed by scroll info;
        // keep just the item viewport and put our counter in the shared help footer instead.
        this.container.addChild({ render: (listWidth) => list.render(listWidth).slice(0, visibleRows), invalidate: () => list.invalidate() });
        this.container.addChild(messageText);
      }
    }
    const count = this.viewModel()?.rows.length ?? 0;
    const counter = `(${count ? this.selectedIndex + 1 : 0}/${count})`;
    const searchStatus = this.searchMode || this.search ? ` • Search: ${this.searchMode ? "/" : ""}${this.search}` : "";
    const detailsStatus = this.details ? " • Details: on" : "";
    const scopeAction = `g ${this.scope === "project" ? "global" : "project"}`;
    const help = width < 80 ? "Esc cancel • / search • d details • Space • Enter save" : "/ search • d details • Space toggle • Enter save • Esc cancel";
    this.container.addChild(new TruncatedText(muted(`${counter} • ${scopeAction}${searchStatus}${detailsStatus} • ${help}`), CONTENT_START_COLUMN, 0));
    this.container.addChild(new DynamicBorder((s: string) => accent(s)));
    const lines = this.container.render(width).map((line) => truncateToWidth(line, width));
    const rows = this.options.terminalRows?.();
    return rows && lines.length > rows ? [...lines.slice(0, Math.max(0, rows - 2)), ...lines.slice(-2)] : lines;
  }

  private selectedRow(): ResourceManagerRow | undefined {
    const rows = this.viewModel()?.rows ?? [];
    return rows.find((row) => row.identity === this.selectedIdentity) ?? rows[this.selectedIndex] ?? rows[0];
  }

  private moveSelection(delta: number): void {
    const rows = this.viewModel()?.rows ?? [];
    if (rows.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(rows.length - 1, this.selectedIndex + delta));
    this.selectedIdentity = rows[this.selectedIndex]?.identity;
  }

  // Render feedback in either host; the Pi overlay also forwards it to its native notification UI.
  private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.status = this.options.theme.fg(type === "info" ? "muted" : type, message);
    this.options.notify(message, type);
  }

  private async toggleSelected(): Promise<void> {
    this.status = undefined;
    const row = this.selectedRow();
    if (!row) return;
    this.selectedIdentity = row.identity;
    if (row.kind === "bundle") {
      if (row.action === "") {
        this.notify(`No editable resources in bundle ${row.name} for ${this.scope} scope`, "warning");
        return;
      }
      const enabled = row.action === "enable";
      const childToggles = (row.childResources ?? [])
        .filter((child) => child.action === row.action)
        .map((child) => ({ type: child.type, name: child.name, scope: this.scope, enabled }));
      if (childToggles.length === 0) {
        this.notify(`No editable resources in bundle ${row.name} for ${this.scope} scope`, "warning");
        return;
      }
      const childKeys = new Set(childToggles.map((toggle) => pendingKey(toggle)));
      this.pending = this.withoutUnchangedToggles([...this.pending.filter((toggle) => !childKeys.has(pendingKey(toggle))), ...childToggles]);
      await this.refresh();
      return;
    }
    if (!row.editable) {
      this.notify(row.readOnlyReason ?? `${row.identity} is read-only`, "warning");
      return;
    }
    const nextEnabled = !(row.pending ? row.pendingEnabled : this.scope === "global" ? row.globalActive : row.projectActive);
    this.pending = this.withoutUnchangedToggles([...this.pending.filter((toggle) => pendingKey(toggle) !== `${this.scope}:${row.identity}`), { type: row.type as ResourceType, name: row.name, scope: this.scope, enabled: nextEnabled }]);
    await this.refresh();
  }

  // Toggling back to the saved choice is an undo, so it must not block a later scope switch.
  private withoutUnchangedToggles(toggles: PendingResourceToggle[]): PendingResourceToggle[] {
    return toggles.filter((toggle) => {
      const state = toggle.scope === "global" ? this.globalState : this.projectState;
      return toggle.enabled !== Boolean(state?.activations.some((activation) => activationIdentity(activation) === identity(toggle.type, toggle.name)));
    });
  }

  // Scope changes only the view and future choices, never an existing staged choice or saved state.
  private switchScope(): void {
    if (this.pending.length > 0) {
      this.notify("Save or undo pending choices before switching scope.", "warning");
      return;
    }
    this.scope = this.scope === "project" ? "global" : "project";
    this.status = undefined;
  }

  // Save through the same sequential writer in both hosts; a failed save never signals completion.
  private async apply(): Promise<void> {
    this.saving = true;
    this.status = undefined;
    try {
      await this.savePending();
    } catch (error) {
      this.saveFailed = true;
      this.notify(`Save failed; some changes may have been written: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.saving = false;
      this.options.requestRender();
    }
  }

  private async savePending(): Promise<void> {
    const preview = await previewPendingResourceChanges(this.options, this.pending);
    this.preview = preview;
    if (!preview.ok) {
      this.saveFailed = true;
      this.notify("Pending pi-ephemeral changes have errors; nothing applied.", "error");
      this.options.requestRender();
      return;
    }
    const result = await applyPendingResourceChanges(this.options, this.pending);
    this.preview = result.plan;
    if (!result.plan.ok) {
      this.saveFailed = true;
      this.notify("Save failed after recomputing plan; some changes may have been written.", "error");
      this.options.requestRender();
      return;
    }
    // A failed earlier attempt may already have written changes, even if the successful retry is a no-op.
    const reloadNeeded = result.plan.changes.length > 0 || this.saveFailed;
    this.saveFailed = false;
    this.notify(`Saved ${result.plan.changes.length} pi-ephemeral change(s).`, "info");
    this.options.done(reloadNeeded ? "applied" : "unchanged");
  }

  private printableInput(data: string): string | undefined {
    return decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
  }

  handleInput(data: string): void {
    const { keybindings } = this.options;
    if (this.saving) return;
    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.done(this.saveFailed ? "failed" : "cancelled");
      this.options.requestRender();
      return;
    }

    if (this.searchMode) {
      if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) this.searchMode = false;
      else if (keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
        this.search = this.search.slice(0, -1);
        this.selectedIndex = 0;
        this.selectedIdentity = undefined;
        if (this.search.length === 0) this.searchMode = false;
      } else {
        const printable = this.printableInput(data);
        if (printable) {
          this.search += printable;
          this.selectedIndex = 0;
          this.selectedIdentity = undefined;
        }
      }
      this.options.requestRender();
      return;
    }

    if (matchesKey(data, Key.slash)) this.searchMode = true;
    else if (this.printableInput(data) === "g" && !this.loading && !this.error) this.switchScope();
    else if (data === "d") {
      this.details = !this.details;
      this.selectedIdentity = undefined;
      this.selectedIndex = 0;
    }
    else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up) || data === "k") this.moveSelection(-1);
    else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down) || data === "j") this.moveSelection(1);
    else if (matchesKey(data, Key.space) && !this.loading && !this.error) void this.toggleSelected();
    else if ((keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) && !this.loading && !this.error) void this.apply();
    this.options.requestRender();
  }
}

export interface LaunchResourceManagerTuiOptions extends PlannerContext {
  scope: ResourceManagerScope;
}

export async function launchResourceManagerTui(ctx: ExtensionCommandContext, options: LaunchResourceManagerTuiOptions): Promise<ResourceManagerResult> {
  const result = await ctx.ui.custom<ResourceManagerResult>(
    (tui, theme, keybindings, done) => new ResourceManagerComponent({
      ...options,
      initialScope: options.scope,
      done,
      notify: (message, type) => ctx.ui.notify(message, type),
      requestRender: () => tui.requestRender(),
      theme,
      selectListTheme: getSelectListTheme(),
      keybindings,
    }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "80%",
        margin: 0,
      },
      onHandle: (handle) => handle.focus(),
    },
  );
  if (result === "cancelled") ctx.ui.notify("Pi-ephemeral changes cancelled. No further changes saved.", "info");
  if (result === "failed") ctx.ui.notify("Save did not complete; some changes may have been written. Resources were not reloaded.", "error");
  return result;
}
