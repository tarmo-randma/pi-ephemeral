import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshOnResourcesDiscover } from "./extension/auto-refresh.js";
import { handleSlashCommand } from "./extension/command.js";
import { discoverHostPackageRoot } from "./extension/host.js";

export default function piEphemeral(pi: ExtensionAPI): void {
  pi.registerCommand("pi-ephemeral", {
    description: "Manage optional Pi resources",
    handler: async (args, ctx) => {
      const packageRoot = discoverHostPackageRoot(pi);
      const output = await handleSlashCommand(args, ctx, { packageRoot });
      if (output) ctx.ui.notify(output.trim(), "info");
    },
  });

  pi.on("resources_discover", async (event, ctx) => {
    const packageRoot = discoverHostPackageRoot(pi);
    return refreshOnResourcesDiscover(event, ctx, { packageRoot });
  });
}
