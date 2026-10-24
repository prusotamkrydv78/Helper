import type {
  Automation,
  Conversation,
  FileChange,
  ID,
  Message,
  Settings,
  Task,
  TaskStep,
  View,
} from "../types";
import { nowISO } from "../lib/utils";

export interface UIState {
  view: View;
  activeConversationId: ID | null;
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  /** Task shown in the details panel; falls back to latest task in conversation. */
  panelTaskId: ID | null;
}

export interface AppState {
  loaded: boolean;
  loadError: string | null;
  conversations: Conversation[];
  tasks: Record<ID, Task>;
  automations: Automation[];
  automationsStatus: "loading" | "ready" | "error";
  settings: Settings;
  ui: UIState;
  /** Conversations currently streaming a reply. */
  streaming: Record<ID, boolean>;
}

export type Action =
  | { type: "hydrate"; conversations: Conversation[]; tasks: Record<ID, Task> }
  | { type: "load_failed"; error: string }
  | { type: "set_view"; view: View }
  | { type: "set_ui"; patch: Partial<UIState> }
  | { type: "create_conversation"; conversation: Conversation }
  | { type: "rename_conversation"; id: ID; title: string }
  | { type: "toggle_pin"; id: ID }
  | { type: "delete_conversation"; id: ID }
  | { type: "clear_conversations" }
  | { type: "add_message"; conversationId: ID; message: Message }
  | { type: "patch_message"; conversationId: ID; messageId: ID; patch: Partial<Message> }
  | { type: "append_token"; conversationId: ID; messageId: ID; text: string }
  | { type: "set_streaming"; conversationId: ID; value: boolean }
  | { type: "add_task"; task: Task }
  | { type: "task_status"; taskId: ID; status: Task["status"]; error?: string; recovery?: string }
  | { type: "step_update"; taskId: ID; step: TaskStep }
  | { type: "file_change"; taskId: ID; file: FileChange }
  | { type: "set_automations"; automations: Automation[] }
  | { type: "automations_status"; status: AppState["automationsStatus"] }
  | { type: "upsert_automation"; automation: Automation }
  | { type: "delete_automation"; id: ID }
  | { type: "update_settings"; patch: Partial<Settings> }
  | { type: "reset_settings"; settings: Settings };

const TERMINAL: Task["status"][] = ["completed", "failed", "cancelled"];
export const isTaskActive = (t: Task) => !TERMINAL.includes(t.status);

function mapConv(state: AppState, id: ID, fn: (c: Conversation) => Conversation): AppState {
  return { ...state, conversations: state.conversations.map((c) => (c.id === id ? fn(c) : c)) };
}

function mapTask(state: AppState, id: ID, fn: (t: Task) => Task): AppState {
  const t = state.tasks[id];
  return t ? { ...state, tasks: { ...state.tasks, [id]: fn(t) } } : state;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return { ...state, loaded: true, conversations: action.conversations, tasks: action.tasks };
    case "load_failed":
      return { ...state, loaded: true, loadError: action.error };
    case "set_view":
      return { ...state, ui: { ...state.ui, view: action.view } };
    case "set_ui":
      return { ...state, ui: { ...state.ui, ...action.patch } };

    case "create_conversation":
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        ui: { ...state.ui, activeConversationId: action.conversation.id, view: "chat", panelTaskId: null },
      };
    case "rename_conversation":
      return mapConv(state, action.id, (c) => ({ ...c, title: action.title }));
    case "toggle_pin":
      return mapConv(state, action.id, (c) => ({ ...c, pinned: !c.pinned }));
    case "delete_conversation": {
      const tasks = Object.fromEntries(
        Object.entries(state.tasks).filter(([, t]) => t.conversationId !== action.id),
      );
      const active = state.ui.activeConversationId === action.id ? null : state.ui.activeConversationId;
      return {
        ...state,
        tasks,
        conversations: state.conversations.filter((c) => c.id !== action.id),
        ui: { ...state.ui, activeConversationId: active },
      };
    }
    case "clear_conversations":
      return { ...state, conversations: [], tasks: {}, ui: { ...state.ui, activeConversationId: null } };

    case "add_message":
      return mapConv(state, action.conversationId, (c) => ({
        ...c,
        updatedAt: nowISO(),
        messages: [...c.messages, action.message],
      }));
    case "patch_message":
      return mapConv(state, action.conversationId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === action.messageId ? { ...m, ...action.patch } : m)),
      }));
    case "append_token":
      return mapConv(state, action.conversationId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === action.messageId ? { ...m, content: m.content + action.text } : m,
        ),
      }));
    case "set_streaming": {
      const streaming = { ...state.streaming };
      if (action.value) streaming[action.conversationId] = true;
      else delete streaming[action.conversationId];
      return { ...state, streaming };
    }

    case "add_task":
      return { ...state, tasks: { ...state.tasks, [action.task.id]: action.task } };
    case "task_status":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        status: action.status,
        error: action.error ?? (action.status === "failed" ? t.error : undefined),
        recovery: action.recovery ?? (action.status === "failed" ? t.recovery : undefined),
        finishedAt: TERMINAL.includes(action.status) ? nowISO() : undefined,
      }));
    case "step_update":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        steps: t.steps.map((s) => (s.id === action.step.id ? action.step : s)),
      }));
    case "file_change":
      return mapTask(state, action.taskId, (t) => ({ ...t, files: [...t.files, action.file] }));

    case "set_automations":
      return { ...state, automations: action.automations, automationsStatus: "ready" };
    case "automations_status":
      return { ...state, automationsStatus: action.status };
    case "upsert_automation": {
      const exists = state.automations.some((a) => a.id === action.automation.id);
      return {
        ...state,
        automations: exists
          ? state.automations.map((a) => (a.id === action.automation.id ? action.automation : a))
          : [action.automation, ...state.automations],
      };
    }
    case "delete_automation":
      return { ...state, automations: state.automations.filter((a) => a.id !== action.id) };

    case "update_settings":
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case "reset_settings":
      return { ...state, settings: action.settings };
  }
}
