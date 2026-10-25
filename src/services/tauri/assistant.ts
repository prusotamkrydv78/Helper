import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauriAi";

export interface MemoryNote {
  id: string;
  text: string;
  category: "preference" | "instruction" | "app" | "project" | "task" | "other";
  createdAt: number;
  source: "user" | "assistant";
  enabled: boolean;
}

export interface AuditEntry {
  ts: number;
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  status: "completed" | "failed" | "declined";
  detail?: string | null;
  durationMs: number;
}

const desktopOnly = () => {
  throw new Error("Available in the desktop app only.");
};

/** Memory, audit history and background features (all backed by the Rust side). */
export const assistantService = {
  available: isTauri(),
  memoryList: async (): Promise<MemoryNote[]> => (isTauri() ? invoke("memory_list") : []),
  memoryAdd: async (text: string, category: string): Promise<MemoryNote> =>
    isTauri() ? invoke("memory_add", { text, category }) : desktopOnly(),
  memoryDelete: async (id: string): Promise<boolean> => (isTauri() ? invoke("memory_delete", { id }) : false),
  memoryUpdate: async (id: string, patch: { text?: string; category?: string; enabled?: boolean }): Promise<MemoryNote> =>
    invoke("memory_update", { id, text: patch.text ?? null, category: patch.category ?? null, enabled: patch.enabled ?? null }),
  memoryClear: async (): Promise<void> => (isTauri() ? invoke("memory_clear") : undefined),
  auditRecent: async (limit = 200): Promise<AuditEntry[]> => (isTauri() ? invoke("audit_recent", { limit }) : []),
  auditClear: async (): Promise<void> => (isTauri() ? invoke("audit_clear") : undefined),
  /** Best effort: failures (e.g. notifications blocked in Windows settings) are ignored. */
  notify: (title: string, body: string): void => {
    if (isTauri()) void invoke("notify", { title, body }).catch(() => {});
  },
  setKeepInTray: (enabled: boolean): void => {
    if (isTauri()) void invoke("set_keep_in_tray", { enabled }).catch(() => {});
  },
  /** CPU, memory, drives, network and top processes (Windows; read-only). */
  systemStatus: async (): Promise<SystemStatus | null> => (isTauri() ? invoke("system_status_now") : null),
  autostartGet: async (): Promise<boolean> => (isTauri() ? invoke("autostart_get") : false),
  autostartSet: async (enabled: boolean): Promise<boolean> => (isTauri() ? invoke("autostart_set", { enabled }) : desktopOnly()),
};

/** Notify only when the user isn't looking at the app. */
export function notifyIfAway(enabled: boolean, title: string, body: string) {
  if (enabled && (document.hidden || !document.hasFocus())) assistantService.notify(title, body);
}

export interface GraphStatus {
  configured: boolean;
  connected: boolean;
  clientId: string;
  tenant: string;
  accountName: string | null;
  accountEmail: string | null;
  scopes: string;
  fromEnv: boolean;
}

/** Microsoft 365 (Graph) connection. Tokens stay in the Rust backend / Credential Manager. */
export const graphService = {
  status: async (): Promise<GraphStatus | null> => (isTauri() ? invoke("graph_status") : null),
  setConfig: async (clientId: string, tenant: string): Promise<GraphStatus> =>
    isTauri() ? invoke("graph_set_config", { clientId, tenant }) : desktopOnly(),
  /** Opens the browser; resolves after sign-in completes (or rejects with the reason). */
  connect: async (): Promise<GraphStatus> => (isTauri() ? invoke("graph_connect") : desktopOnly()),
  cancelConnect: async (): Promise<void> => (isTauri() ? invoke("graph_cancel_connect") : undefined),
  disconnect: async (): Promise<GraphStatus> => (isTauri() ? invoke("graph_disconnect") : desktopOnly()),
};

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  clientId: string;
  hasClientSecret: boolean;
  accountEmail: string | null;
  scopes: string;
}

/** Google Workspace connection. The client secret and tokens stay in Credential Manager. */
export const googleService = {
  status: async (): Promise<GoogleStatus | null> => (isTauri() ? invoke("google_status") : null),
  /** An empty secret keeps the stored one. */
  setConfig: async (clientId: string, clientSecret: string): Promise<GoogleStatus> =>
    isTauri() ? invoke("google_set_config", { clientId, clientSecret }) : desktopOnly(),
  connect: async (): Promise<GoogleStatus> => (isTauri() ? invoke("google_connect") : desktopOnly()),
  cancelConnect: async (): Promise<void> => (isTauri() ? invoke("google_cancel_connect") : undefined),
  disconnect: async (): Promise<GoogleStatus> => (isTauri() ? invoke("google_disconnect") : desktopOnly()),
};

export interface SystemStatus {
  cpu_percent: number | null;
  memory: { total_mb: number; available_mb: number; used_percent: number } | null;
  drives: { drive: string; total_gb: number; free_gb: number }[];
  processes_total: number;
  top_processes_by_memory: { pid: number; name: string; memory_mb: number }[];
  network: { route_to_internet: boolean; local_ip?: string };
}

// ---- clipboard history, file rules, shortcuts, voice ----------------------------

export interface ClipItem {
  id: number;
  kind: "text" | "image";
  text: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  pinned: boolean;
  at: number;
  preview: string | null;
}

export interface ClipHistoryView {
  enabled: boolean;
  skippedSensitive: number;
  items: ClipItem[];
}

export interface OrganizeRule {
  id: string;
  name: string;
  path: string;
  by: "extension" | "year" | "month" | "pattern";
  pattern?: string;
  extensions?: string[];
  target?: string;
}

export interface UndoEntry {
  id: number;
  at: number;
  label: string;
  moves: [string, string][];
}

/** Only the fields the backend's organize tool accepts. */
export const ruleArgs = (r: OrganizeRule) => ({
  path: r.path,
  by: r.by,
  ...(r.pattern?.trim() ? { pattern: r.pattern.trim() } : {}),
  ...(r.extensions?.length ? { extensions: r.extensions } : {}),
  ...(r.by === "pattern" ? { target: r.target ?? "" } : {}),
});

export const featureService = {
  clipHistory: async (query?: string): Promise<ClipHistoryView | null> => (isTauri() ? invoke("clipboard_history_get", { query: query || null }) : null),
  clipSetEnabled: async (enabled: boolean): Promise<void> => (isTauri() ? invoke("clipboard_history_set_enabled", { enabled }) : undefined),
  clipPin: async (id: number, pinned: boolean): Promise<void> => invoke("clipboard_history_pin", { id, pinned }),
  clipDelete: async (id: number): Promise<void> => invoke("clipboard_history_delete", { id }),
  clipClear: async (): Promise<void> => (isTauri() ? invoke("clipboard_history_clear") : undefined),
  clipRestore: async (id: number): Promise<void> => invoke("clipboard_history_restore", { id }),

  rulesLoad: async (): Promise<OrganizeRule[]> => (isTauri() ? invoke("rules_load") : []),
  rulesSave: async (rules: OrganizeRule[]): Promise<void> => (isTauri() ? invoke("rules_save", { rules }) : desktopOnly()),
  rulePreview: async (r: OrganizeRule): Promise<string> => invoke("organize_rule_preview", { rule: ruleArgs(r) }),
  ruleApply: async (r: OrganizeRule): Promise<{ moved: number; failed: number }> => invoke("organize_rule_apply", { rule: ruleArgs(r) }),
  undoList: async (): Promise<UndoEntry[]> => (isTauri() ? invoke("file_undo_list") : []),
  undoPreview: async (id: number): Promise<string> => invoke("file_undo_preview", { id }),
  undoApply: async (id: number): Promise<{ moved: number; failed: number }> => invoke("file_undo_apply", { id }),

  /** Returns the shortcuts that couldn't be registered. */
  setShortcuts: async (map: Record<string, string>): Promise<string[]> => (isTauri() ? invoke("shortcuts_set", { map }) : []),
  voiceListen: async (): Promise<string> => (isTauri() ? invoke("voice_listen") : desktopOnly()),
  voiceCancel: async (): Promise<void> => (isTauri() ? invoke("voice_cancel") : undefined),

  layoutsLoad: async (): Promise<{ name: string; windows: LayoutWindow[] }[]> => (isTauri() ? invoke("layouts_load") : []),
  layoutsSave: async (layouts: { name: string; windows: LayoutWindow[] }[]): Promise<void> => invoke("layouts_save", { layouts }),
  layoutCapture: async (): Promise<LayoutWindow[]> => invoke("layout_capture"),
  layoutPreview: async (windows: LayoutWindow[]): Promise<LayoutPreviewRow[]> => invoke("layout_preview", { windows }),
  layoutApply: async (windows: LayoutWindow[], launchMissing: boolean, allowedApps: string[]): Promise<{ arranged: number; launched?: string[] }> =>
    invoke("layout_apply", { windows, launchMissing, allowedApps }),
  /** Local only: nothing is sent to the AI. */
  documentsSearch: async (path: string, query: string): Promise<{ results: DocResult[]; searched_files: number }> => invoke("documents_search", { path, query }),
};

export interface LayoutWindow {
  exe: string;
  title: string;
  rect: [number, number, number, number];
  state: "normal" | "maximized" | "minimized";
}

export interface LayoutPreviewRow {
  exe: string;
  title: string;
  state: string;
  match: { window: number; title: string } | null;
}

export interface DocResult {
  file: string;
  line: number;
  score: number;
  excerpt: string;
}
