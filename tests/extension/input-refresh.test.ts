import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerActivationInputRefresh } from "../../src/extension/input-refresh.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(homedir(), ".cache", "pi-input-refresh-test-"));
  roots.push(root);
  const agent = join(root, "agent");
  const project = join(root, "project");
  await mkdir(agent);
  await mkdir(project);
  const handlers: Record<string, (event: never, ctx: never) => Promise<unknown>> = {};
  const pi = {
    on: vi.fn((name: string, handler: typeof handlers[string]) => { handlers[name] = handler; }),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn(() => []),
  };
  const refresh = registerActivationInputRefresh(pi as never, agent);
  await refresh.rememberLoadedChoices(project);
  const context = { cwd: project, isIdle: () => true, model: { id: "fixture" }, modelRegistry: { hasConfiguredAuth: vi.fn(() => true) } };
  const input = (ctx = context, event = { text: "Original input", source: "rpc", images: undefined, streamingBehavior: undefined as string | undefined }) => handlers.input!(event as never, ctx as never);
  const change = () => writeFile(join(agent, "pi-ephemeral-global.json"), JSON.stringify({ version: 1, activations: [{ type: "skill", name: "new", target: "skills/new" }] }));
  return { pi, refresh, context, input, change };
}

// A replay cannot start an agent without synchronous model/auth readiness; preserve Pi's own preflight error.
describe("activation input refresh", () => {
  it.each(["no model", "no auth"])("does not intercept input with %s", async (condition) => {
    const fx = await fixture();
    await fx.change();
    const context = condition === "no model" ? { ...fx.context, model: undefined } : fx.context;
    if (condition === "no auth") context.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await expect(fx.input(context as typeof fx.context)).resolves.toBeUndefined();
    expect(fx.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  // Busy steering must keep the active resource set; a rejected reload must not repeat for identical choices.
  it("leaves steering alone, then records an idle refresh attempt even on failure", async () => {
    const fx = await fixture();
    await fx.change();
    await fx.input({ ...fx.context, isIdle: () => false });
    await fx.input(fx.context, { text: "steer", source: "rpc", images: undefined, streamingBehavior: "steer" });
    expect(fx.pi.sendUserMessage).not.toHaveBeenCalled();
    fx.pi.sendUserMessage.mockImplementation(() => fx.refresh.takeReloadCompletion()?.(new Error("reload failed")));
    await expect(fx.input()).rejects.toThrow("reload failed");
    await expect(fx.input()).resolves.toBeUndefined();
    expect(fx.pi.sendUserMessage).toHaveBeenCalledExactlyOnceWith("/pi-ephemeral reload", { expandPromptTemplates: true });
  });
});
