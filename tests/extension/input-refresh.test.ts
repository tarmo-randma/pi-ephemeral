import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerActivationInputRefresh } from "../../src/extension/input-refresh.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "pi-input-refresh-test-"));
  roots.push(root);
  const agent = join(root, "agent");
  const project = join(root, "project");
  const cwd = join(project, "nested");
  await mkdir(agent);
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(cwd);
  await exec("git", ["init", "--quiet", project]);
  const handlers: Record<string, (event: never, ctx: never) => Promise<unknown>> = {};
  const commands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }> = {};
  const pi = {
    on: vi.fn((name: string, handler: typeof handlers[string]) => { handlers[name] = handler; }),
    registerCommand: vi.fn((name: string, command: typeof commands[string]) => { commands[name] = command; }),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn(() => []),
  };
  const register = () => registerActivationInputRefresh(pi as never, agent);
  await register().rememberBaseline(cwd);
  const context = { cwd, isIdle: () => true, model: { id: "fixture" }, modelRegistry: { hasConfiguredAuth: vi.fn(() => true) } };
  const commandContext = {
    waitForIdle: vi.fn(), ui: { notify: vi.fn() },
    reload: vi.fn(async () => { await register().rememberBaseline(cwd); }),
  };
  const commandErrors: unknown[] = [];
  pi.sendUserMessage.mockImplementation((message: string | unknown[]) => {
    if (typeof message === "string") {
      void commands[message.slice(1)]!.handler("", commandContext as never).catch((error) => commandErrors.push(error));
    } else {
      void handlers.agent_start!({} as never, context as never);
    }
  });
  const input = (ctx = context, event = { text: "Original input", source: "rpc", images: undefined, streamingBehavior: undefined as string | undefined }) => handlers.input!(event as never, ctx as never);
  const statePath = (scope: "global" | "project") => scope === "global"
    ? join(agent, "pi-ephemeral-global.json") : join(project, ".pi", "pi-ephemeral.json");
  const change = (scope: "global" | "project" = "global") => writeFile(statePath(scope), JSON.stringify({
    version: 1, activations: [{ type: "skill", name: "new", target: `${scope === "project" ? ".pi/" : ""}skills/new` }],
  }));
  return { pi, register, context, input, change, statePath, commandContext, commandErrors };
}

describe("activation input refresh", () => {
  // A replay cannot start without model/auth readiness; preserve Pi's own preflight error.
  it.each(["no model", "no auth"])("does not intercept input with %s", async (condition) => {
    const fx = await fixture();
    await fx.change();
    const context = condition === "no model" ? { ...fx.context, model: undefined } : fx.context;
    if (condition === "no auth") context.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await expect(fx.input(context as typeof fx.context)).resolves.toBeUndefined();
    expect(fx.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  // Both scopes must refresh once from a nested Git directory without needing another extension loaded.
  it.each(["global", "project"] as const)("reloads changed %s activation and replays once through the fresh runtime", async (scope) => {
    const fx = await fixture();
    await fx.change(scope);
    await expect(fx.input()).resolves.toEqual({ action: "handled" });
    expect(fx.commandContext.reload).toHaveBeenCalledOnce();
    expect(fx.pi.sendUserMessage.mock.calls).toEqual([
      ["/pi-ephemeral-input-refresh", { expandPromptTemplates: true }],
      [[{ type: "text", text: "Original input" }], { expandPromptTemplates: true }],
    ]);
    await expect(fx.input()).resolves.toBeUndefined();
    expect(fx.pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(fx.commandErrors).toEqual([]);
  });

  // File formatting, object key order and activation ordering do not change the saved choices.
  it("compares normalized activations in both scopes", async () => {
    const fx = await fixture();
    for (const scope of ["global", "project"] as const) {
      const activations = ["a", "b"].map((name) => ({ type: "skill", name, target: `${scope === "project" ? ".pi/" : ""}skills/${name}` }));
      await writeFile(fx.statePath(scope), JSON.stringify({ version: 1, activations }));
      await fx.register().rememberBaseline(fx.context.cwd);
      await writeFile(fx.statePath(scope), JSON.stringify({ activations: activations.reverse(), version: 1 }, null, 2));
      await expect(fx.input()).resolves.toBeUndefined();
    }
    expect(fx.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  // Busy steering must keep the active set; failed reloads consume input without replay or retry loops.
  it("leaves steering alone, then records an idle refresh attempt even on failure", async () => {
    const fx = await fixture();
    await fx.change();
    await fx.input({ ...fx.context, isIdle: () => false });
    await fx.input(fx.context, { text: "steer", source: "rpc", images: undefined, streamingBehavior: "steer" });
    expect(fx.pi.sendUserMessage).not.toHaveBeenCalled();
    fx.commandContext.reload.mockRejectedValue(new Error("reload failed"));
    await expect(fx.input()).resolves.toEqual({ action: "handled" });
    await expect(fx.input()).resolves.toBeUndefined();
    expect(fx.commandErrors).toEqual([expect.objectContaining({ message: expect.stringContaining("this message was not run") })]);
    expect(fx.pi.sendUserMessage).toHaveBeenCalledExactlyOnceWith("/pi-ephemeral-input-refresh", { expandPromptTemplates: true });
  });
});
