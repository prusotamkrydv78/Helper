import type { Settings, ToolPermission } from "../types";

export const DEFAULT_PERMISSIONS: ToolPermission[] = [
  { tool: "fs.read", label: "Read files", description: "List folders and read file contents", level: "allow", risk: "low" },
  { tool: "fs.write", label: "Create & modify files", description: "Write, move and rename files", level: "ask", risk: "medium" },
  { tool: "fs.delete", label: "Delete files", description: "Move files/folders inside allowed folders to the Recycle Bin. Every deletion shows all targets and asks; Deny hides the tool.", level: "deny", risk: "high" },
  { tool: "browser", label: "Browser actions", description: "Open pages, search and read freely. Ask = approve each click and typed entry. Form submits, password fields and downloads always ask.", level: "ask", risk: "medium" },
  { tool: "shell", label: "Terminal commands", description: "Run commands in PowerShell", level: "ask", risk: "high" },
  { tool: "system", label: "System info & actions", description: "Read CPU, memory, disks, network and processes. Ending a process always asks; system and admin processes are refused.", level: "ask", risk: "medium" },
  { tool: "m365", label: "Microsoft 365 mail & calendar", description: "Search and read mail, read calendars and availability. Drafts follow this setting; sending mail and creating events always ask.", level: "ask", risk: "medium" },
  { tool: "google", label: "Google Gmail & Calendar", description: "Search and read Gmail, read Google Calendar and free/busy. Drafts follow this setting; sending mail and creating events always ask.", level: "ask", risk: "medium" },
  { tool: "input", label: "Mouse & keyboard input", description: "Fallback clicks, scrolling, drags, shortcuts and typing in app windows when UI Automation can't. Every action asks; password fields and Windows-key shortcuts are refused. Needs Desktop apps too.", level: "deny", risk: "high" },
  { tool: "clipboard", label: "Clipboard", description: "Copy text to the clipboard (asks per this setting) and read it (always asks).", level: "deny", risk: "medium" },
  { tool: "apps", label: "Desktop apps", description: "Read and operate app windows. Launching, clicking and typing always ask. Admin windows and password fields are refused.", level: "deny", risk: "high" },
];


export const DEFAULT_SETTINGS: Settings = {
  sendOnEnter: true,
  autoScroll: true,
  showTaskPanelAutomatically: true,
  keepInTray: false,
  notifications: true,
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
  allowedApps: "",
  sandboxMode: true,
};
