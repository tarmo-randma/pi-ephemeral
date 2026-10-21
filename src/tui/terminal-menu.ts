import { getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { ResourceManagerComponent, type LaunchResourceManagerTuiOptions, type ResourceManagerResult } from "./resource-manager.js";

// Host the existing manager in a normal terminal, restoring input modes before returning to its caller.
export async function launchTerminalMenu(options: LaunchResourceManagerTuiOptions): Promise<ResourceManagerResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("menu requires an interactive terminal");
  initTheme("dark", false);
  const selectListTheme = getSelectListTheme();
  const markdownTheme = getMarkdownTheme();
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  let finish!: (result: ResourceManagerResult) => void;
  const result = new Promise<ResourceManagerResult>((resolve) => { finish = resolve; });
  const component = new ResourceManagerComponent({
    ...options,
    initialScope: options.scope,
    done: finish,
    notify: () => {}, // The component renders feedback; never write over a running TUI.
    requestRender: () => tui.requestRender(),
    theme: {
      fg: (color, text) => color === "accent" ? selectListTheme.selectedText(text)
        : color === "error" ? `\x1b[31m${text}\x1b[39m`
        : color === "warning" ? `\x1b[33m${text}\x1b[39m`
        : selectListTheme.description(text),
      bold: markdownTheme.bold,
    },
    selectListTheme,
    keybindings: getKeybindings(),
    terminalRows: () => terminal.rows,
    scopeHelp: "Scope fixed at launch. For global choices: pi-ephemeral menu --global",
  });
  tui.addChild(component);
  tui.setFocus(component);
  try {
    tui.start();
    return await result;
  } finally {
    tui.stop();
  }
}
