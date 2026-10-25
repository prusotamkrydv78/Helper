// Core domain types shared by UI, store and services.

export type ID = string;
export type ISODate = string;

export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "stopped" | "error";

export interface Message {
  id: ID;
  role: MessageRole;
  content: string;
  createdAt: ISODate;
  status: MessageStatus;
  /** Task started from this message, if any. */
  taskId?: ID;
  /** Mock responses are labeled so they are never mistaken for real AI output. */
  source?: "mock" | "ai";
  /** Model that produced a live response. */
  model?: string;
  error?: string;
  /** Backend error kind (e.g. "missing_api_key", "rate_limited") for tailored recovery UI. */
  errorKind?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  id: ID;
  name: string;
  size: number;
  type: string;
}

export interface Conversation {
  id: ID;
  title: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  messages: Message[];
  pinned?: boolean;
}

export type TaskStatus =
  | "planning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type RiskLevel = "low" | "medium" | "high";

export interface ToolResult {
  /** Raw tool output — kept separate from AI narration. */
  output: string;
  format: "text" | "json" | "table";
}

export interface TaskStep {
  id: ID;
  tool: string;
  title: string;
  description: string;
  status: StepStatus;
  input?: Record<string, unknown>;
  result?: ToolResult;
  error?: string;
  requiresApproval: boolean;
  risk: RiskLevel;
  startedAt?: ISODate;
  finishedAt?: ISODate;
}

export type FileChangeKind = "created" | "modified" | "moved" | "deleted";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  /** True when the change was only simulated (demo mode). */
  simulated: boolean;
}

export interface Task {
  id: ID;
  conversationId: ID;
  title: string;
  summary: string;
  status: TaskStatus;
  steps: TaskStep[];
  files: FileChange[];
  createdAt: ISODate;
  finishedAt?: ISODate;
  error?: string;
  recovery?: string;
  /** Demo tasks never touch the real system. */
  isDemo: boolean;
}

export type ScheduleKind = "manual" | "hourly" | "daily" | "weekly";

export interface Automation {
  id: ID;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduleKind;
  /** Time of day for daily/weekly, "HH:MM". */
  time: string;
  lastRunAt: ISODate | null;
  /** Most recent (demo) run; status is read from the task itself. */
  lastRunTaskId: ID | null;
  createdAt: ISODate;
  isSample: boolean;
}

export type ThemePref = "dark" | "light" | "system";
export type FontSize = "sm" | "md" | "lg";
export type PermissionLevel = "ask" | "allow" | "deny";

export interface ToolPermission {
  tool: string;
  label: string;
  description: string;
  level: PermissionLevel;
  risk: RiskLevel;
}

export interface Settings {
  // General
  sendOnEnter: boolean;
  autoScroll: boolean;
  showTaskPanelAutomatically: boolean;
  // Appearance
  theme: ThemePref;
  fontSize: FontSize;
  compactMessages: boolean;
  reduceMotion: boolean;
  // AI model. The API key is never stored here — it lives in the OS credential store.
  /** Empty string = the backend default (`OPENAI_MODEL` or the built-in fallback). */
  model: string;
  systemPrompt: string;
  // Tool permissions (UI only)
  permissions: ToolPermission[];
  // Privacy & execution
  storeHistoryLocally: boolean;
  requireApprovalForHighRisk: boolean;
  maxStepsPerTask: number;
  sandboxMode: boolean;
}

export type AgentConnection =
  | { state: "checking" }
  | { state: "not_installed"; checkedAt: ISODate; detail: string }
  | { state: "disconnected"; checkedAt: ISODate; detail: string }
  | { state: "connected"; checkedAt: ISODate; version: string };

/** AI backend configuration as reported by the Rust side. Never contains the key. */
export interface AiStatus {
  /** False when running outside Tauri (e.g. plain browser dev) — chat falls back to the mock. */
  available: boolean;
  provider: string;
  configured: boolean;
  source: "environment" | "keychain" | null;
  keyHint: string | null;
}

export type View ="chat" | "tasks" | "automations" | "history" | "settings";
