import type { Settings, ToolPermission } from "../types";

export const DEFAULT_PERMISSIONS: ToolPermission[] = [
  { tool: "fs.read", label: "Read files", description: "List folders and read file contents", level: "allow", risk: "low" },
  { tool: "fs.write", label: "Create & modify files", description: "Write, move and rename files", level: "ask", risk: "medium" },
  { tool: "fs.delete", label: "Delete files", description: "Remove files and folders", level: "ask", risk: "high" },
  { tool: "browser", label: "Browser actions", description: "Open pages, search and read freely. Ask = approve each click and typed entry. Form submits, password fields and downloads always ask.", level: "ask", risk: "medium" },
  { tool: "shell", label: "Terminal commands", description: "Run commands in PowerShell", level: "ask", risk: "high" },
  { tool: "apps", label: "Desktop apps", description: "Launch and control applications", level: "deny", risk: "high" },
];


export const DEFAULT_SETTINGS: Settings = {
  sendOnEnter: true,
  autoScroll: true,
  showTaskPanelAutomatically: true,
  theme: "dark",
  fontSize: "md",
  compactMessages: false,
  reduceMotion: false,
  model: "",
  systemPrompt: "You are a careful desktop automation assistant. Always ask before changing files.",
  permissions: DEFAULT_PERMISSIONS,
  storeHistoryLocally: true,
  requireApprovalForHighRisk: true,
  maxStepsPerTask: 20,
  sandboxMode: true,
};
