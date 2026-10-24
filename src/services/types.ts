// The contract between the UI and the AI orchestration / tool execution layers.
// Swap the mock implementation for a real one (HTTP, Tauri commands, websockets)
// without touching components.

import type {
  AgentConnection,
  Automation,
  Conversation,
  ID,
  Message,
  Settings,
  Task,
  TaskStep,
} from "../types";

export interface ChatRequest {
  conversationId: ID;
  /** Full history including the new user message. */
  messages: Pick<Message, "role" | "content">[];
  settings: Pick<Settings, "provider" | "model" | "temperature" | "systemPrompt" | "maxStepsPerTask">;
}

/** Events emitted while an assistant response is produced. */
export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "task_started"; task: Task }
  | { type: "done" }
  | { type: "error"; message: string };

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

export interface Backend {
  /** True while the app runs on mock implementations. */
  readonly isMock: boolean;
  chat: ChatService;
  tasks: TaskService;
  automations: AutomationService;
  agent: AgentService;
}
