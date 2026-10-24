import type { Settings, ToolPermission } from "../types";

export const DEFAULT_PERMISSIONS: ToolPermission[] = [
  { tool: "fs.read", label: "Read files", description: "List folders and read file contents", level: "allow", risk: "low" },
  { tool: "fs.write", label: "Create & modify files", description: "Write, move and rename files", level: "ask", risk: "medium" },
  { tool: "fs.delete", label: "Delete files", description: "Remove files and folders", level: "ask", risk: "high" },
  { tool: "browser", label: "Browser actions", description: "Open pages, search, read and fill forms", level: "ask", risk: "medium" },
  { tool: "shell", label: "Terminal commands", description: "Run commands in PowerShell", level: "ask", risk: "high" },
  { tool: "apps", label: "Desktop apps", description: "Launch and control applications", level: "deny", risk: "high" },
];

export const MODELS: Record<Settings["provider"], string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  openai: ["gpt-model-placeholder"],
  local: ["local-model"],
};

export const DEFAULT_SETTINGS: Settings = {
  sendOnEnter: true,
  autoScroll: true,
  showTaskPanelAutomatically: true,
  theme: "dark",
  fontSize: "md",
  compactMessages: false,
  reduceMotion: false,
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  temperature: 0.7,
  apiKey: "",
  systemPrompt: "You are a careful desktop automation assistant. Always ask before changing files.",
  permissions: DEFAULT_PERMISSIONS,
  storeHistoryLocally: true,
  requireApprovalForHighRisk: true,
  maxStepsPerTask: 20,
  sandboxMode: true,
};
