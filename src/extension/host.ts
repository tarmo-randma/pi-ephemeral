import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CommandLike {
  name?: string;
  source?: string;
  sourceInfo?: { baseDir?: string };
}

export function discoverHostPackageRoot(pi: Pick<ExtensionAPI, "getCommands">): string {
  const baseDirs = new Set<string>();
  for (const command of pi.getCommands() as CommandLike[]) {
    if (command.name !== "pi-ephemeral" || command.source !== "extension") continue;
    if (command.sourceInfo?.baseDir) baseDirs.add(command.sourceInfo.baseDir);
  }
  if (baseDirs.size === 0) throw new Error("No pi-ephemeral host package baseDir found from pi.getCommands()");
  if (baseDirs.size > 1) throw new Error(`Multiple pi-ephemeral host package base dirs found: ${[...baseDirs].sort().join(", ")}`);
  return [...baseDirs][0]!;
}
