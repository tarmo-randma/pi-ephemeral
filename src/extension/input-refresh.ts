import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInputRefresh } from "@tarmo-randma/t3-pi-refresh";
import { globalStatePath, projectStatePath, resolveProjectRoot } from "../core/project-index.js";
import { readActivationState } from "../core/state.js";

// Compare normalized saved choices, not file formatting, mtimes or catalogue metadata.
async function savedChoices(cwd: string, agentDir: string): Promise<string> {
  const projectRoot = await resolveProjectRoot(cwd);
  const global = await readActivationState(globalStatePath(agentDir), { scope: "global" });
  const project = await readActivationState(projectStatePath(projectRoot), { scope: "project" });
  return JSON.stringify([projectRoot, global.activations, project.activations]);
}

// Supply activation fingerprints; the shared library owns reload, handoff and fresh-runtime replay.
export function registerActivationInputRefresh(pi: ExtensionAPI, agentDir = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent")) {
  return registerInputRefresh(pi, {
    namespace: "pi-ephemeral",
    readFingerprint: (cwd) => savedChoices(cwd, agentDir),
  });
}
