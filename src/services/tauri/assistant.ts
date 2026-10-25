import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauriAi";

export interface MemoryNote {
  id: string;
  text: string;
  category: "preference" | "project" | "task" | "other";
  createdAt: number;
  source: "user" | "assistant";
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
