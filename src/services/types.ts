// The contract between the UI and the AI orchestration / tool execution layers.
// Swap implementations (mock, Tauri commands, HTTP) without touching components.

import type {
  AgentConnection,
  AiStatus,
  Automation,
  Conversation,
  ID,
  Message,
  PermissionLevel,
  Settings,
  StepStatus,
  Task,
  TaskStep,
} from "../types";

export interface ChatRequest {
  conversationId: ID;
  /** Full ordered history including the new user message. */
  messages: Pick<Message, "role" | "content">[];
  settings: Pick<Settings, "model" | "systemPrompt" | "maxStepsPerTask">;
  /** File tool permissions, enforced by the backend. */
  permissions: { read: PermissionLevel; write: PermissionLevel };
}

export interface ToolFileChange {
  path: string;
  kind: "created" | "modified";
}

/** Events emitted while an assistant response is produced, in order. */
export type ChatEvent =
  | { type: "start"; model: string }
  | { type: "token"; text: string }
  | { type: "task_started"; task: Task }
  /** Live backend: id of the request (used to answer tool approvals). */
  | { type: "request"; requestId: string }
  /** Live backend: the model asked to run a real tool. */
  | {
      type: "tool_call";
      callId: string;
      name: string;
      title: string;
      arguments: unknown;
      requiresApproval: boolean;
      readOnly: boolean;
    }
  /** Live backend: real progress/result of a tool call. */
  | {
      type: "tool_status";
      callId: string;
      status: Exclude<StepStatus, "pending">;
      summary?: string | null;
      output?: string | null;
      error?: string | null;
      file?: ToolFileChange | null;
    }
  | { type: "done" }
  | { type: "error"; message: string; kind?: string; retryable?: boolean };

/** Events emitted while a task executes. */
export type TaskEvent =
  | { type: "task_status"; taskId: ID; status: Task["status"]; error?: string; recovery?: string }
  | { type: "step_update"; taskId: ID; step: TaskStep }
  | { type: "file_change"; taskId: ID; file: Task["files"][number] }
  | { type: "task_summary"; taskId: ID; summary: string };

export type Unsubscribe = () => void;

export interface ChatService {
  /** Streams the assistant reply. Resolves when the stream ends; honours `signal` for stop. */
  streamChat(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void>;
  loadConversations(): Promise<Conversation[]>;
}

export interface TaskService {
  /** Subscribe to tool-call events and results for all tasks. */
  subscribe(onEvent: (e: TaskEvent) => void): Unsubscribe;
  approveStep(taskId: ID, stepId: ID): Promise<void>;
  rejectStep(taskId: ID, stepId: ID, reason?: string): Promise<void>;
  cancelTask(taskId: ID): Promise<void>;
  /** Re-runs a failed/cancelled task; returns the new task. */
  retryTask(task: Task): Promise<Task>;
}

export interface AutomationService {
  list(): Promise<Automation[]>;
  save(a: Automation): Promise<Automation>;
  remove(id: ID): Promise<void>;
  /** Starts a run of the automation in a conversation and returns the task. */
  runNow(a: Automation, conversationId: ID): Promise<Task>;
}

export interface AgentService {
  /** Checks connectivity to the local PC executor. */
  checkConnection(): Promise<AgentConnection>;
}

/** AI provider configuration. Keys go in, never come back out. */
export interface AiConfigService {
  status(): Promise<AiStatus>;
  setApiKey(key: string): Promise<AiStatus>;
  clearApiKey(): Promise<AiStatus>;
  /** Answers a live tool-approval prompt. */
  resolveToolApproval(requestId: string, callId: string, approved: boolean): Promise<boolean>;
  /** Folders the file tools may access. */
  listAllowedDirs(): Promise<string[]>;
  /** Opens a folder picker; resolves to the new list, or null if cancelled. */
  addAllowedDir(): Promise<string[] | null>;
  removeAllowedDir(path: string): Promise<string[]>;
}

export interface Backend {
  /** Mock chat — used when no live AI backend is configured. */
  mockChat: ChatService;
  /** Live chat via the Rust backend, or null outside Tauri. */
  liveChat: ChatService | null;
  ai: AiConfigService;
  /** Tasks, automations and the local agent are still mocked. */
  tasks: TaskService;
  automations: AutomationService;
  agent: AgentService;
}
