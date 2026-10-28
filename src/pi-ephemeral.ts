import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshOnResourcesDiscover } from "./extension/auto-refresh.js";
import { handleSlashCommand } from "./extension/command.js";
import { discoverHostPackageRoot } from "./extension/host.js";
import { registerActivationInputRefresh } from "./extension/input-refresh.js";

export default function piEphemeral(pi: ExtensionAPI): void {
  const inputRefresh = registerActivationInputRefresh(pi);
  pi.registerCommand("pi-ephemeral", {
    description: "Manage optional Pi resources",
    handler: async (args, ctx) => {
      const packageRoot = discoverHostPackageRoot(pi);
      const output = await handleSlashCommand(args, ctx, { packageRoot });
      // Reloading commands return no output: their old context is now stale.
      if (output) ctx.ui.notify(output.trim(), "info");
    },
  });

  pi.on("resources_discover", async (event, ctx) => {
    const packageRoot = discoverHostPackageRoot(pi);
    const resources = await refreshOnResourcesDiscover(event, ctx, { packageRoot });
    await inputRefresh.rememberBaseline(event.cwd || ctx.cwd);
    return resources;
  });
}
