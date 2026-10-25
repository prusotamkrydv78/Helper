import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { backend } from "../services";
import type {
  AgentConnection,
  AiStatus,
  Attachment,
  Automation,
  Conversation,
  ID,
  Message,
  Settings,
  StepStatus,
  Task,
  View,
} from "../types";
import { load, remove, save } from "../lib/storage";
import { nowISO, titleFromPrompt, uid } from "../lib/utils";
import { DEFAULT_SETTINGS } from "./defaults";
import { isTaskActive, reducer, type AppState, type UIState } from "./reducer";

// ---------------------------------------------------------------------------
// Initial state (synchronous parts read from storage)
// ---------------------------------------------------------------------------

/** Settings from older versions held an `apiKey` in localStorage — never load it back. */
const LEGACY_SETTING_KEYS = ["apiKey", "temperature", "provider"];

function loadSettings(): Settings {
  const stored = load<Record<string, unknown>>("settings", {});
  const hadLegacy = LEGACY_SETTING_KEYS.some((k) => k in stored);
  LEGACY_SETTING_KEYS.forEach((k) => delete stored[k]);
  if (hadLegacy) save("settings", stored); // scrub the old key from disk right away
  // Older defaults named Claude models; the backend now uses OpenAI.
  if (typeof stored.model === "string" && stored.model.startsWith("claude-")) stored.model = "";
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

const isLive = (ai: AiStatus | null): boolean => Boolean(ai?.available && ai.configured && backend.liveChat);

/** History sent to the model: in order, without failed replies or mock (demo) text. */
/** One-line description of a tool call for the step list, e.g. the path it touches. */
function describeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "Invalid arguments";
  const a = args as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  if (str("query")) return `“${str("query")}”`;
  if (str("url") && !str("directory")) return str("url");
  if (str("ref") && !str("directory")) {
    const text = str("text");
    return text ? `${str("ref")} ← “${text.slice(0, 40)}”${a.submit === true ? " · submit" : ""}` : `element ${str("ref")}`;
  }
  const path = str("path") || str("directory");
  const extras = [a.recursive === true && "recursive", a.overwrite === true && "overwrite", str("url") && "from URL"].filter(Boolean);
  return [path ? shortPath(path) : "(no path)", ...extras].join(" · ");
}

/** Keeps the meaningful end of long paths: "…\workspace\summary\todo.md". */
function shortPath(p: string): string {
  if (p.length <= 48) return p;
  const parts = p.split(/[\\/]/).filter(Boolean);
  const sep = p.includes("\\") ? "\\" : "/";
  return parts.length > 3 ? `…${sep}${parts.slice(-3).join(sep)}` : p;
}

function toHistory(messages: Message[]): Pick<Message, "role" | "content">[] {
  return messages
    .filter((m) => m.status !== "error" && m.source !== "mock" && m.content.trim())
    .map(({ role, content }) => ({ role, content }));
}

function initialState(): AppState {
  const settings = loadSettings();
  const ui = load<Partial<UIState>>("ui", {});
  return {
    loaded: false,
    loadError: null,
    conversations: [],
    tasks: {},
    automations: [],
    automationsStatus: "loading",
    settings,
    streaming: {},
    ui: {
      view: ui.view ?? "chat",
      activeConversationId: ui.activeConversationId ?? null,
      sidebarCollapsed: ui.sidebarCollapsed ?? false,
      panelOpen: ui.panelOpen ?? false,
      panelTaskId: null,
    },
  };
}

/** Tasks that were mid-run when the app closed can't resume — mark them honestly. */
function reviveTasks(raw: Record<ID, Task>): Record<ID, Task> {
  const out: Record<ID, Task> = {};
  for (const [id, t] of Object.entries(raw)) {
    out[id] = isTaskActive(t)
      ? {
          ...t,
          status: "cancelled",
          finishedAt: t.finishedAt ?? nowISO(),
          error: "Interrupted — the app was closed while this task was running.",
          steps: t.steps.map((s) =>
            ["running", "pending", "awaiting_approval"].includes(s.status)
              ? { ...s, status: "cancelled" }
              : s,
          ),
        }
      : t;
  }
  return out;
}

function reviveConversations(raw: Conversation[]): Conversation[] {
  return raw.map((c) => ({
    ...c,
    messages: c.messages.map((m) => (m.status === "streaming" ? { ...m, status: "stopped" } : m)),
  }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface Actions {
  setView(view: View): void;
  toggleSidebar(): void;
  togglePanel(open?: boolean): void;
  openTask(taskId: ID): void;

  newChat(): void;
  selectConversation(id: ID): void;
  renameConversation(id: ID, title: string): void;
  deleteConversation(id: ID): void;
  togglePin(id: ID): void;

  sendMessage(text: string, attachments?: Attachment[]): void;
  stopGeneration(conversationId: ID): void;
  regenerate(conversationId: ID): void;

  approveStep(taskId: ID, stepId: ID): void;
  rejectStep(taskId: ID, stepId: ID): void;
  cancelTask(taskId: ID): void;
  retryTask(taskId: ID): void;

  reloadAutomations(): void;
  saveAutomation(a: Automation): void;
  duplicateAutomation(id: ID): void;
  deleteAutomation(id: ID): void;
  runAutomation(id: ID): void;

  updateSettings(patch: Partial<Settings>): void;
  resetSettings(): void;
  clearAllData(): void;
  checkAgent(): void;

  refreshAi(): void;
  /** Rejects with a BackendError (e.g. invalid key format) — callers show it. */
  saveApiKey(key: string): Promise<void>;
  removeApiKey(): Promise<void>;
  /** Opens a folder picker; resolves true if a folder was added. Rejects with a BackendError. */
  addAllowedDir(): Promise<boolean>;
  removeAllowedDir(path: string): Promise<void>;
}

interface StoreValue {
  state: AppState;
  actions: Actions;
  agent: AgentConnection;
  /** AI backend configuration; null while loading. */
  ai: AiStatus | null;
  /** True when chat goes to the real AI backend (otherwise the mock). */
  liveChat: boolean;
  /** Folders the real file tools may access. */
  allowedDirs: string[];
}

const StoreContext = createContext<StoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [agent, setAgent] = useState<AgentConnection>({ state: "checking" });
  const streams = useRef(new Map<ID, AbortController>());
  // Latest state for async callbacks without re-creating actions.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [allowedDirs, setAllowedDirs] = useState<string[]>([]);
  const aiRef = useRef(ai);
  aiRef.current = ai;

  // ---- Hydration --------------------------------------------------------
  useEffect(() => {
    let alive = true;
    backend.mockChat
      .loadConversations()
      .then((convs) => {
        if (!alive) return;
        dispatch({
          type: "hydrate",
          conversations: reviveConversations(convs),
          tasks: reviveTasks(load<Record<ID, Task>>("tasks", {})),
        });
      })
      .catch((e: unknown) => {
        if (alive) dispatch({ type: "load_failed", error: e instanceof Error ? e.message : "Failed to load history" });
      });

    backend.automations
      .list()
      .then((automations) => alive && dispatch({ type: "set_automations", automations }))
      .catch(() => alive && dispatch({ type: "automations_status", status: "error" }));

    backend.agent.checkConnection().then((c) => alive && setAgent(c));
    backend.ai
      .status()
      .then((s) => alive && setAi(s))
      .then(() => backend.ai.listAllowedDirs())
      .then((d) => alive && Array.isArray(d) && setAllowedDirs(d))
      .catch(() => alive && setAi({ available: true, provider: "openai", configured: false, source: null, keyHint: null }));
    return () => {
      alive = false;
    };
  }, []);

  // ---- Task events from the backend --------------------------------------
  useEffect(
    () =>
      backend.tasks.subscribe((e) => {
        switch (e.type) {
          case "task_status":
            dispatch({ type: "task_status", taskId: e.taskId, status: e.status, error: e.error, recovery: e.recovery });
            break;
          case "step_update":
            dispatch({ type: "step_update", taskId: e.taskId, step: e.step });
            break;
          case "file_change":
            dispatch({ type: "file_change", taskId: e.taskId, file: e.file });
            break;
          case "task_summary":
            break;
        }
      }),
    [],
  );

  // ---- Persistence --------------------------------------------------------
  useEffect(() => {
    if (!state.loaded) return;
    const t = setTimeout(() => {
      if (state.settings.storeHistoryLocally) {
        save("conversations", state.conversations);
        save("tasks", state.tasks);
      } else {
        remove("conversations");
        remove("tasks");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [state.loaded, state.conversations, state.tasks, state.settings.storeHistoryLocally]);

  useEffect(() => save("settings", state.settings), [state.settings]);
  useEffect(() => {
    if (state.automationsStatus === "ready") save("automations", state.automations);
  }, [state.automations, state.automationsStatus]);
  useEffect(() => {
    const { view, activeConversationId, sidebarCollapsed, panelOpen } = state.ui;
    save("ui", { view, activeConversationId, sidebarCollapsed, panelOpen });
  }, [state.ui]);

  // Drop a stale active id (e.g. history was cleared elsewhere).
  useEffect(() => {
    const id = state.ui.activeConversationId;
    if (state.loaded && id && !state.conversations.some((c) => c.id === id))
      dispatch({ type: "set_ui", patch: { activeConversationId: null } });
  }, [state.loaded, state.conversations, state.ui.activeConversationId]);

  // ---- Helpers -------------------------------------------------------------
  const createConversation = useCallback((title = "New chat"): ID => {
    const conversation: Conversation = {
      id: uid("conv"),
      title,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      messages: [],
    };
    dispatch({ type: "create_conversation", conversation });
    return conversation.id;
  }, []);

  const runAssistant = useCallback((conversationId: ID, history: Pick<Message, "role" | "content">[]) => {
    const s = stateRef.current.settings;
    const live = isLive(aiRef.current);
    const chat = live && backend.liveChat ? backend.liveChat : backend.mockChat;
    const assistant: Message = {
      id: uid("msg"),
      role: "assistant",
      content: "",
      createdAt: nowISO(),
      status: "streaming",
      source: live ? "ai" : "mock",
    };
    dispatch({ type: "add_message", conversationId, message: assistant });
    dispatch({ type: "set_streaming", conversationId, value: true });

    const controller = new AbortController();
    streams.current.get(conversationId)?.abort();
    streams.current.set(conversationId, controller);
    let finalStatus: Message["status"] = "complete";
    let finalError: string | undefined;

    // Live tool calls are tracked as a (non-demo) task on this assistant message.
    let requestId: string | undefined;
    let liveTaskId: ID | null = null;
    const stepStatus = new Map<string, StepStatus>();
    const ensureLiveTask = (): ID => {
      if (liveTaskId) return liveTaskId;
      const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
      const task: Task = {
        id: uid("task"),
        conversationId,
        title: "Tool activity",
        summary: titleFromPrompt(lastUser),
        status: "running",
        steps: [],
        files: [],
        createdAt: nowISO(),
        isDemo: false,
        requestId,
      };
      liveTaskId = task.id;
      dispatch({ type: "add_task", task });
      dispatch({ type: "patch_message", conversationId, messageId: assistant.id, patch: { taskId: task.id } });
      if (stateRef.current.settings.showTaskPanelAutomatically)
        dispatch({ type: "set_ui", patch: { panelOpen: true, panelTaskId: task.id } });
      return task.id;
    };
    const syncLiveTaskStatus = () => {
      if (!liveTaskId) return;
      const awaiting = [...stepStatus.values()].includes("awaiting_approval");
      dispatch({ type: "task_status", taskId: liveTaskId, status: awaiting ? "awaiting_approval" : "running" });
    };

    chat
      .streamChat(
        {
          conversationId,
          messages: history,
          settings: { model: s.model, systemPrompt: s.systemPrompt, maxStepsPerTask: s.maxStepsPerTask, allowedApps: s.allowedApps },
          permissions: {
            read: s.permissions.find((p) => p.tool === "fs.read")?.level ?? "allow",
            write: s.permissions.find((p) => p.tool === "fs.write")?.level ?? "ask",
            browser: s.permissions.find((p) => p.tool === "browser")?.level ?? "ask",
            apps: s.permissions.find((p) => p.tool === "apps")?.level ?? "deny",
          },
        },
        (e) => {
          switch (e.type) {
            case "start":
              dispatch({ type: "patch_message", conversationId, messageId: assistant.id, patch: { model: e.model } });
              break;
            case "request":
              requestId = e.requestId;
              break;
            case "tool_call": {
              const taskId = ensureLiveTask();
              stepStatus.set(e.callId, "pending");
              dispatch({
                type: "add_step",
                taskId,
                step: {
                  id: e.callId,
                  tool: e.name,
                  title: e.title,
                  description: describeToolArgs(e.arguments),
                  status: "pending",
                  input: e.arguments && typeof e.arguments === "object" ? (e.arguments as Record<string, unknown>) : { raw: e.arguments },
                  requiresApproval: e.requiresApproval,
                  risk: e.readOnly ? "low" : "medium",
                },
              });
              break;
            }
            case "tool_status": {
              if (!liveTaskId) break;
              stepStatus.set(e.callId, e.status);
              const terminal = e.status !== "running" && e.status !== "awaiting_approval";
              dispatch({
                type: "patch_step",
                taskId: liveTaskId,
                stepId: e.callId,
                patch: {
                  status: e.status,
                  ...(e.status === "running" ? { startedAt: nowISO() } : {}),
                  ...(terminal ? { finishedAt: nowISO() } : {}),
                  ...(e.output ? { result: { output: e.output, format: "json" as const } } : {}),
                  ...(e.error ? { error: e.error } : {}),
                  ...(e.status === "awaiting_approval" && e.summary ? { approvalReason: e.summary } : {}),
                },
              });
              if (e.file) dispatch({ type: "file_change", taskId: liveTaskId, file: { ...e.file, simulated: false } });
              syncLiveTaskStatus();
              break;
            }
            case "token":
              dispatch({ type: "append_token", conversationId, messageId: assistant.id, text: e.text });
              break;
            case "task_started":
              dispatch({ type: "add_task", task: e.task });
              dispatch({ type: "patch_message", conversationId, messageId: assistant.id, patch: { taskId: e.task.id } });
              if (stateRef.current.settings.showTaskPanelAutomatically)
                dispatch({ type: "set_ui", patch: { panelOpen: true, panelTaskId: e.task.id } });
              break;
            case "error":
              finalStatus = "error";
              finalError = e.message;
              dispatch({
                type: "patch_message",
                conversationId,
                messageId: assistant.id,
                // A refused response's partial text shouldn't be presented as an answer.
                patch: { error: e.message, errorKind: e.kind, ...(e.kind === "refusal" ? { content: "" } : {}) },
              });
              break;
            case "done":
              break;
          }
        },
        controller.signal,
      )
      .catch((e: unknown) => {
        finalStatus = "error";
        dispatch({
          type: "patch_message",
          conversationId,
          messageId: assistant.id,
          patch: { error: e instanceof Error ? e.message : "Something went wrong" },
        });
      })
      .finally(() => {
        if (controller.signal.aborted) finalStatus = "stopped";
        dispatch({ type: "patch_message", conversationId, messageId: assistant.id, patch: { status: finalStatus } });
        if (liveTaskId) {
          // Steps that never reached a final state didn't run (or were interrupted).
          for (const [stepId, st] of stepStatus) {
            if (st === "pending" || st === "running" || st === "awaiting_approval")
              dispatch({ type: "patch_step", taskId: liveTaskId, stepId, patch: { status: "cancelled", finishedAt: nowISO() } });
          }
          dispatch({
            type: "task_status",
            taskId: liveTaskId,
            status: finalStatus === "stopped" ? "cancelled" : finalStatus === "error" ? "failed" : "completed",
            error: finalStatus === "error" ? finalError : finalStatus === "stopped" ? "Stopped by you." : undefined,
          });
        }
        dispatch({ type: "set_streaming", conversationId, value: false });
        if (streams.current.get(conversationId) === controller) streams.current.delete(conversationId);
      });
  }, []);

  const startTaskMessage = useCallback((conversationId: ID, task: Task, content: string) => {
    dispatch({ type: "add_task", task });
    dispatch({
      type: "add_message",
      conversationId,
      message: {
        id: uid("msg"),
        role: "assistant",
        content,
        createdAt: nowISO(),
        status: "complete",
        source: "mock",
        taskId: task.id,
      },
    });
    dispatch({ type: "set_ui", patch: { panelOpen: true, panelTaskId: task.id } });
  }, []);

  // ---- Actions -------------------------------------------------------------
  const actions = useMemo<Actions>(
    () => ({
      setView: (view) => dispatch({ type: "set_view", view }),
      toggleSidebar: () =>
        dispatch({ type: "set_ui", patch: { sidebarCollapsed: !stateRef.current.ui.sidebarCollapsed } }),
      togglePanel: (open) =>
        dispatch({ type: "set_ui", patch: { panelOpen: open ?? !stateRef.current.ui.panelOpen } }),
      openTask: (taskId) => {
        const task = stateRef.current.tasks[taskId];
        if (!task) return;
        dispatch({
          type: "set_ui",
          patch: { view: "chat", activeConversationId: task.conversationId, panelOpen: true, panelTaskId: taskId },
        });
      },

      newChat: () => {
        const { ui, conversations } = stateRef.current;
        const active = conversations.find((c) => c.id === ui.activeConversationId);
        if (active && active.messages.length === 0) {
          dispatch({ type: "set_view", view: "chat" });
          return;
        }
        // Start on the empty state; the conversation is created on first send.
        dispatch({ type: "set_ui", patch: { view: "chat", activeConversationId: null, panelTaskId: null } });
      },
      selectConversation: (id) =>
        dispatch({ type: "set_ui", patch: { view: "chat", activeConversationId: id, panelTaskId: null } }),
      renameConversation: (id, title) => {
        const t = title.trim();
        if (t) dispatch({ type: "rename_conversation", id, title: t.slice(0, 80) });
      },
      deleteConversation: (id) => {
        streams.current.get(id)?.abort();
        Object.values(stateRef.current.tasks)
          .filter((t) => t.conversationId === id && isTaskActive(t))
          .forEach((t) => void backend.tasks.cancelTask(t.id));
        dispatch({ type: "delete_conversation", id });
      },
      togglePin: (id) => dispatch({ type: "toggle_pin", id }),

      sendMessage: (text, attachments) => {
        const content = text.trim();
        if (!content) return;
        let convId = stateRef.current.ui.activeConversationId;
        let conv = stateRef.current.conversations.find((c) => c.id === convId);
        if (!conv) {
          convId = createConversation(titleFromPrompt(content));
          conv = undefined;
        } else if (conv.messages.length === 0 && conv.title === "New chat") {
          dispatch({ type: "rename_conversation", id: conv.id, title: titleFromPrompt(content) });
        }
        if (!convId || stateRef.current.streaming[convId]) return;

        const userMsg: Message = {
          id: uid("msg"),
          role: "user",
          content,
          createdAt: nowISO(),
          status: "complete",
          attachments: attachments?.length ? attachments : undefined,
        };
        dispatch({ type: "add_message", conversationId: convId, message: userMsg });
        runAssistant(convId, toHistory([...(conv?.messages ?? []), userMsg]));
      },
      stopGeneration: (conversationId) => streams.current.get(conversationId)?.abort(),
      regenerate: (conversationId) => {
        const conv = stateRef.current.conversations.find((c) => c.id === conversationId);
        if (!conv || stateRef.current.streaming[conversationId]) return;
        // Replay everything up to and including the latest user message.
        const lastUserIdx = conv.messages.map((m) => m.role).lastIndexOf("user");
        if (lastUserIdx < 0) return;
        runAssistant(conversationId, toHistory(conv.messages.slice(0, lastUserIdx + 1)));
      },

      // Demo tasks go to the mock; live tasks answer the real backend.
      approveStep: (taskId, stepId) => {
        const t = stateRef.current.tasks[taskId];
        if (t && !t.isDemo && t.requestId) void backend.ai.resolveToolApproval(t.requestId, stepId, true);
        else void backend.tasks.approveStep(taskId, stepId);
      },
      rejectStep: (taskId, stepId) => {
        const t = stateRef.current.tasks[taskId];
        if (t && !t.isDemo && t.requestId) void backend.ai.resolveToolApproval(t.requestId, stepId, false);
        else void backend.tasks.rejectStep(taskId, stepId);
      },
      cancelTask: (taskId) => {
        const t = stateRef.current.tasks[taskId];
        if (t && !t.isDemo) streams.current.get(t.conversationId)?.abort();
        else void backend.tasks.cancelTask(taskId);
      },
      retryTask: (taskId) => {
        const old = stateRef.current.tasks[taskId];
        if (!old) return;
        if (!old.isDemo) {
          // A live task is retried by asking the model again.
          const conv = stateRef.current.conversations.find((c) => c.id === old.conversationId);
          if (!conv || stateRef.current.streaming[conv.id]) return;
          const lastUserIdx = conv.messages.map((m) => m.role).lastIndexOf("user");
          if (lastUserIdx >= 0) runAssistant(conv.id, toHistory(conv.messages.slice(0, lastUserIdx + 1)));
          return;
        }
        backend.tasks.retryTask(old).then((task) =>
          startTaskMessage(old.conversationId, task, `Retrying **${old.title}** from the beginning.`),
        );
      },

      addAllowedDir: async () => {
        const dirs = await backend.ai.addAllowedDir();
        if (dirs) setAllowedDirs(dirs);
        return dirs !== null;
      },
      removeAllowedDir: async (path) => setAllowedDirs(await backend.ai.removeAllowedDir(path)),

      reloadAutomations: () => {
        dispatch({ type: "automations_status", status: "loading" });
        backend.automations
          .list()
          .then((automations) => dispatch({ type: "set_automations", automations }))
          .catch(() => dispatch({ type: "automations_status", status: "error" }));
      },
      saveAutomation: (a) => {
        backend.automations.save(a).then((saved) => dispatch({ type: "upsert_automation", automation: saved }));
      },
      duplicateAutomation: (id) => {
        const a = stateRef.current.automations.find((x) => x.id === id);
        if (!a) return;
        dispatch({
          type: "upsert_automation",
          automation: {
            ...a,
            id: uid("auto"),
            name: `${a.name} (copy)`,
            enabled: false,
            lastRunAt: null,
            lastRunTaskId: null,
            createdAt: nowISO(),
            isSample: false,
          },
        });
      },
      deleteAutomation: (id) => {
        backend.automations.remove(id).then(() => dispatch({ type: "delete_automation", id }));
      },
      runAutomation: (id) => {
        const a = stateRef.current.automations.find((x) => x.id === id);
        if (!a) return;
        const convId = createConversation(`${a.name} · demo run`);
        backend.automations.runNow(a, convId).then((task) => {
          startTaskMessage(
            convId,
            task,
            `Started a **demo run** of the automation **${a.name}**.\n\n> ${a.prompt}\n\nThis run is simulated — the scheduler and local executor aren't connected yet.`,
          );
          dispatch({ type: "upsert_automation", automation: { ...a, lastRunAt: nowISO(), lastRunTaskId: task.id } });
        });
      },

      updateSettings: (patch) => dispatch({ type: "update_settings", patch }),
      resetSettings: () => dispatch({ type: "reset_settings", settings: DEFAULT_SETTINGS }),
      clearAllData: () => {
        streams.current.forEach((c) => c.abort());
        Object.values(stateRef.current.tasks)
          .filter(isTaskActive)
          .forEach((t) => void backend.tasks.cancelTask(t.id));
        remove("conversations");
        remove("tasks");
        dispatch({ type: "clear_conversations" });
      },
      checkAgent: () => {
        setAgent({ state: "checking" });
        backend.agent.checkConnection().then(setAgent);
      },

      refreshAi: () => {
        backend.ai.status().then(setAi).catch(() => {});
      },
      saveApiKey: async (key) => setAi(await backend.ai.setApiKey(key)),
      removeApiKey: async () => setAi(await backend.ai.clearApiKey()),
    }),
    [createConversation, runAssistant, startTaskMessage],
  );

  const value = useMemo(
    () => ({ state, actions, agent, ai, liveChat: isLive(ai), allowedDirs }),
    [state, actions, agent, ai, allowedDirs],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside AppStoreProvider");
  return ctx;
}

export function useActiveConversation(): Conversation | null {
  const { state } = useStore();
  return state.conversations.find((c) => c.id === state.ui.activeConversationId) ?? null;
}
