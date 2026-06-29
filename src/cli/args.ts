import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ResourceType } from "../core/types.js";

interface BaseCommand {
  json: boolean;
  packageRoot: string;
  agentDir?: string;
  cwd: string;
}

export type CliCommand =
  | { command: "help" }
  | (BaseCommand & { command: "list"; all: boolean; width: number; filter?: string })
  | (BaseCommand & { command: "status"; all: boolean; width: number })
  | (BaseCommand & { command: "info"; mode: "exact"; type: ResourceType; name: string; width: number })
  | (BaseCommand & { command: "info"; mode: "query"; query: string; width: number })
  | (BaseCommand & { command: "enable"; type: ResourceType; name: string; scope: "global" | "project" })
  | (BaseCommand & { command: "disable"; type: ResourceType; name: string; scope: "global" | "project" })
  | (BaseCommand & { command: "repair" });

const COMMANDS = ["list", "status", "info", "enable", "disable", "repair"] as const;
const RESOURCE_TYPES = ["skill", "extension", "prompt", "theme"] as const;
const CONTEXT_FLAGS = new Set(["--package", "--agent-dir", "--cwd"]);

export class ArgParseError extends Error {}

export const HELP_TEXT = `pi-ephemeral manages optional Pi resources from a package catalog.

list
  Show available resources, grouped by bundle, optionally filtered by query.
  Use this to discover what can be enabled.
  Pattern: pi-ephemeral list [--filter <query>] [--all] [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]

status
  Show active resources only. Bundles may show * when only some children are active.
  Use this to see what is currently available to Pi.
  Pattern: pi-ephemeral status [--all] [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]

info
  Show details by exact resource identity or search query.
  Pattern: pi-ephemeral info <type> <name> [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]
          pi-ephemeral info <query> [--json] [-w|--width <columns>] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]

enable
  Activate one optional resource in the selected scope.
  Pattern: pi-ephemeral enable <type> <name> [--global|--project] [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]

disable
  Deactivate one optional resource from the selected scope.
  Pattern: pi-ephemeral disable <type> <name> [--global|--project] [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]

repair
  Repair active resources everywhere relevant: global activations, indexed projects, and the current project when it has .pi/pi-ephemeral.json with activations.
  Pattern: pi-ephemeral repair [--json] [--package <dir>] [--agent-dir <dir>] [--cwd <dir>]

Common flags
  --package <dir>: explicit package/catalog root; overrides packageRoot from global pi-ephemeral config.
  --agent-dir <dir>: Pi agent config dir; defaults to ~/.pi/agent, mainly for tests/alternate profiles.
  --cwd <dir>: project context for project state resolution; defaults to current directory.
  --json: machine-readable output for scripts; stable exact-command shape.
  -w, --width <columns>: human table width; default 100.

Types: skill, extension, prompt, theme
`;

function isResourceType(value: string): value is ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value);
}

function rejectSlashAndShort(token: string): void {
  if (token.startsWith("/")) throw new ArgParseError("Slash command syntax is not valid for the CLI");
  if (/^-[^-]/.test(token) && token !== "-w") throw new ArgParseError("Short flags are not supported");
}

function parseWidth(value: string | undefined): number {
  if (!value || value.startsWith("-")) throw new ArgParseError("--width requires a value");
  const width = Number(value);
  if (!Number.isInteger(width) || width < 40) throw new ArgParseError("Width must be an integer of at least 40 columns");
  return width;
}

type ParsedOptions = { all: boolean; json: boolean; width: number; filter?: string; scope?: "global" | "project"; packageRoot?: string; agentDir?: string; cwd: string };

function parseOptions(tokens: string[]): ParsedOptions {
  const options: ParsedOptions = { all: false, json: false, width: 100, cwd: process.cwd() };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    rejectSlashAndShort(token);
    if (!token.startsWith("--") && token !== "-w") throw new ArgParseError(`Unexpected positional argument ${token}. See --help for usage.`);
    if (token === "--json") options.json = true;
    else if (token === "--all") options.all = true;
    else if (token === "--filter") {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) throw new ArgParseError("--filter requires a value");
      options.filter = value;
    } else if (token === "--width" || token === "-w") options.width = parseWidth(tokens[++i]);
    else if (token === "--global" || token === "--project") {
      const nextScope = token === "--global" ? "global" : "project";
      if (options.scope && options.scope !== nextScope) throw new ArgParseError("Conflicting scope flags: use only one of --global or --project");
      options.scope = nextScope;
    } else if (CONTEXT_FLAGS.has(token)) {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) throw new ArgParseError(`${token} requires a value`);
      if (token === "--package") options.packageRoot = resolve(value);
      else if (token === "--agent-dir") options.agentDir = resolve(value);
      else options.cwd = resolve(value);
    } else throw new ArgParseError(`Unknown flag ${token}`);
  }
  return options;
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

function packageRootFromGlobalConfig(agentDir: string): string | undefined {
  const configPath = join(agentDir, "pi-ephemeral-global.json");
  let parsed: { packageRoot?: unknown };
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as { packageRoot?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (parsed.packageRoot === undefined) return undefined;
  if (typeof parsed.packageRoot !== "string" || parsed.packageRoot.trim().length === 0) throw new ArgParseError(`Invalid packageRoot in ${configPath}`);
  return resolve(dirname(configPath), parsed.packageRoot);
}

function requirePackageRoot(options: Pick<ParsedOptions, "packageRoot" | "agentDir">): string {
  const packageRoot = options.packageRoot ?? packageRootFromGlobalConfig(options.agentDir ?? defaultAgentDir());
  if (!packageRoot) throw new ArgParseError("Could not infer package root; pass --package <dir>");
  return packageRoot;
}

function parseType(value: string | undefined): ResourceType {
  if (!value || !isResourceType(value)) throw new ArgParseError(`Invalid resource type ${value ?? ""}. Resource type must be one of: ${RESOURCE_TYPES.join(", ")}`);
  return value;
}

function rejectUnsupportedFilter(command: string, options: Pick<ParsedOptions, "filter">): void {
  if (options.filter) throw new ArgParseError(`${command} does not accept --filter`);
}

function parseRepairOptions(tokens: string[]): Pick<ParsedOptions, "json" | "packageRoot" | "agentDir" | "cwd"> {
  const options: Pick<ParsedOptions, "json" | "packageRoot" | "agentDir" | "cwd"> = { json: false, cwd: process.cwd() };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--all") throw new ArgParseError("repair does not accept --all");
    if (token === "--global" || token === "--project") throw new ArgParseError("repair does not accept scope flags");
    if (token === "--filter") throw new ArgParseError("repair does not accept --filter");
    if (token === "--width" || token === "-w") throw new ArgParseError("repair does not accept --width");
    if (!token.startsWith("--")) throw new ArgParseError("repair does not accept resource arguments");
    if (token === "--json") options.json = true;
    else if (CONTEXT_FLAGS.has(token)) {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) throw new ArgParseError(`${token} requires a value`);
      if (token === "--package") options.packageRoot = resolve(value);
      else if (token === "--agent-dir") options.agentDir = resolve(value);
      else options.cwd = resolve(value);
    } else throw new ArgParseError(`Unknown flag ${token}`);
  }
  return options;
}

export function parseArgs(argv: string[]): CliCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") return { command: "help" };
  const [command, ...rest] = argv;
  rejectSlashAndShort(command!);
  if (!(COMMANDS as readonly string[]).includes(command!)) throw new ArgParseError(`Unknown command ${command}.\n${HELP_TEXT}`);

  if (command === "list" || command === "status") {
    const options = parseOptions(rest);
    if (options.scope) throw new ArgParseError(`${command} does not accept --global or --project`);
    if (command !== "list") rejectUnsupportedFilter(command, options);
    if (command === "list") return { command, all: options.all, filter: options.filter, json: options.json, width: options.width, packageRoot: requirePackageRoot(options), agentDir: options.agentDir, cwd: options.cwd };
    return { command, all: options.all, json: options.json, width: options.width, packageRoot: requirePackageRoot(options), agentDir: options.agentDir, cwd: options.cwd };
  }

  if (command === "info") {
    const positionalCount = rest.findIndex((token) => token.startsWith("-"));
    const positionals = positionalCount === -1 ? rest : rest.slice(0, positionalCount);
    const optionTokens = positionalCount === -1 ? [] : rest.slice(positionalCount);
    const options = parseOptions(optionTokens);
    if (options.all) throw new ArgParseError("info does not accept --all");
    if (options.scope) throw new ArgParseError("info does not accept --global or --project");
    rejectUnsupportedFilter("info", options);
    const base = { json: options.json, width: options.width, packageRoot: requirePackageRoot(options), agentDir: options.agentDir, cwd: options.cwd };
    if (positionals.length === 1) {
      if (isResourceType(positionals[0]!)) throw new ArgParseError(`Invalid usage for info.\n${HELP_TEXT}`);
      return { command: "info", mode: "query", query: positionals[0]!, ...base };
    }
    if (positionals.length === 2) {
      return { command: "info", mode: "exact", type: parseType(positionals[0]), name: positionals[1]!, ...base };
    }
    throw new ArgParseError(`Invalid usage for info.\n${HELP_TEXT}`);
  }

  if (command === "enable" || command === "disable") {
    if (rest.length < 2 || rest[0]!.startsWith("--") || rest[1]!.startsWith("--")) throw new ArgParseError(`Invalid usage for ${command}.\n${HELP_TEXT}`);
    const type = parseType(rest[0]);
    const name = rest[1]!;
    const options = parseOptions(rest.slice(2));
    if (options.all) throw new ArgParseError(`${command} does not accept --all`);
    rejectUnsupportedFilter(command, options);
    return { command, type, name, scope: options.scope ?? "project", json: options.json, packageRoot: requirePackageRoot(options), agentDir: options.agentDir, cwd: options.cwd };
  }

  const options = parseRepairOptions(rest);
  return { command: "repair", json: options.json, packageRoot: requirePackageRoot(options), agentDir: options.agentDir, cwd: options.cwd };
}
