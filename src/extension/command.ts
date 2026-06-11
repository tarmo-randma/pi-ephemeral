import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runCli } from "../cli.js";
import { ArgParseError, HELP_TEXT, parseArgs, type CliCommand } from "../cli/args.js";
import { resolveProjectRoot } from "../core/project-index.js";
import { launchResourceManagerTui } from "../tui/resource-manager.js";

export interface ExtensionRuntimeContext {
  packageRoot: string;
  agentDir?: string;
}

const CLI_ONLY_FLAGS = new Set(["--cwd", "--package", "--agent-dir"]);

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) throw new ArgParseError("Unterminated quote in pi-ephemeral command");
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function rejectCliOnly(tokens: string[]): void {
  for (const token of tokens) {
    if (CLI_ONLY_FLAGS.has(token)) throw new ArgParseError(`${token} is CLI-only and is not supported by /pi-ephemeral`);
  }
}

export function parseSlashArgs(input: string): CliCommand {
  const tokens = splitArgs(input);
  rejectCliOnly(tokens);
  if (tokens.length === 0) return { command: "help" };
  return parseArgs([...tokens, "--package", process.cwd()]);
}

function isTuiLaunch(input: string, ctx: Pick<ExtensionCommandContext, "mode">): "global" | "project" | undefined {
  const tokens = splitArgs(input);
  if (ctx.mode !== "tui") return undefined;
  if (tokens.length === 0) return "project";
  if (tokens.length === 1 && tokens[0] === "--global") return "global";
  return undefined;
}

export async function handleSlashCommand(args: string, ctx: ExtensionCommandContext, runtime: ExtensionRuntimeContext): Promise<string | undefined> {
  const tuiScope = isTuiLaunch(args, ctx);
  if (tuiScope) {
    const agentDir = runtime.agentDir ?? defaultAgentDir();
    await launchResourceManagerTui(ctx, { packageRoot: runtime.packageRoot, agentDir, projectRoot: await resolveProjectRoot(ctx.cwd), scope: tuiScope });
    return undefined;
  }

  // Validate with the slash parser first so CLI-only context flags produce slash-specific errors.
  parseSlashArgs(args);
  const tokens = splitArgs(args);
  if (tokens.length === 0) return HELP_TEXT;
  const agentDir = runtime.agentDir ?? defaultAgentDir();
  const argv = [...tokens, "--package", runtime.packageRoot, "--agent-dir", agentDir, "--cwd", ctx.cwd];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
  if (exitCode !== 0) throw new Error(stderr.join("").trim() || `pi-ephemeral command failed with exit code ${exitCode}`);
  const output = stdout.join("");
  return output.length > 0 ? output : HELP_TEXT;
}
