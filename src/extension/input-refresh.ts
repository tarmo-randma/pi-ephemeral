import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { globalStatePath, projectStatePath, resolveProjectRoot } from "../core/project-index.js";
import { readActivationState } from "../core/state.js";

type ReloadCompletion = (error?: unknown) => void;
type PreservedInput = Pick<InputEvent, "text" | "images">;
// Pi 1.3's public option; retain build compatibility with older wildcard-peer declaration files.
const expandCommands: Parameters<ExtensionAPI["sendUserMessage"]>[1] & { expandPromptTemplates: true } = { expandPromptTemplates: true };
interface InputHandoff {
  resume?: (input: PreservedInput) => Promise<void>;
  started?: () => void;
}

const handoffKey = Symbol.for("@tarmo-randma/pi-ephemeral/input-handoff");
const processState = globalThis as typeof globalThis & { [handoffKey]?: InputHandoff };
const handoff = processState[handoffKey] ??= {};

// Compare normalized saved choices, not file formatting, mtimes or catalogue metadata.
async function savedChoices(cwd: string, agentDir: string): Promise<string> {
  const projectRoot = await resolveProjectRoot(cwd);
  const global = await readActivationState(globalStatePath(agentDir), { scope: "global" });
  const project = await readActivationState(projectStatePath(projectRoot), { scope: "project" });
  return JSON.stringify([projectRoot, global.activations, project.activations]);
}

// Reload at a new idle input, then let the fresh runtime process the original message exactly once.
export function registerActivationInputRefresh(pi: ExtensionAPI, agentDir = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent")) {
  let loadedChoices: string | undefined;
  let completeReload: ReloadCompletion | undefined;

  // Only plain promises and this callback survive reload; no old Pi API/context is used to replay input.
  handoff.resume = async (input) => {
    const commandName = input.text.startsWith("/") ? input.text.slice(1).split(/\s/, 1)[0] : undefined;
    const commandOnly = commandName && pi.getCommands().some((command) => command.source === "extension" && command.name === commandName);
    const started = commandOnly ? Promise.resolve() : new Promise<void>((resolve) => { handoff.started = resolve; });
    pi.sendUserMessage([{ type: "text", text: input.text }, ...(input.images ?? [])], expandCommands);
    // Current T3 needs ordinary replay activity before the original RPC input resolves handled.
    // A newly enabled extension slash command has no agent_start; T3 settles its original slash via idle probe.
    await started;
  };
  pi.on("agent_start", () => {
    const started = handoff.started;
    handoff.started = undefined;
    started?.();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.streamingBehavior || !ctx.isIdle()) return;
    // Preserve Pi's native preflight error instead of waiting for replay activity that cannot start.
    // Async-only auth providers can still use the explicit reload command.
    if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return;
    const currentChoices = await savedChoices(ctx.cwd, agentDir);
    if (currentChoices === loadedChoices) return;
    // Remember the attempt too: a failed Pi reload must not cause a retry loop for the same disk choices.
    loadedChoices = currentChoices;
    const reloaded = new Promise<void>((resolve, reject) => {
      completeReload = (error) => error ? reject(error) : resolve();
    });
    pi.sendUserMessage("/pi-ephemeral reload", expandCommands);
    await reloaded;
    await handoff.resume!({ text: event.text, images: event.images });
    return { action: "handled" };
  });

  return {
    // Called at the existing discovery boundary, after its normal activation repair.
    async rememberLoadedChoices(cwd: string): Promise<void> {
      loadedChoices = await savedChoices(cwd, agentDir);
    },
    // Capture in the command before reload invalidates its runtime; afterward settle only this plain gate.
    takeReloadCompletion(): ReloadCompletion | undefined {
      const complete = completeReload;
      completeReload = undefined;
      return complete;
    },
  };
}
