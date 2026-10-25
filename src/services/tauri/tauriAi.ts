// Live AI services backed by the Rust commands in src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiStatus } from "../../types";
import { load } from "../../lib/storage";
import { uid } from "../../lib/utils";
import type { AiConfigService, ChatService } from "../types";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Mirrors `StreamEvent` in src-tauri/src/ai/types.rs. */
type RustStreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      title: string;
      arguments: unknown;
      requiresApproval: boolean;
      readOnly: boolean;
    }
  | {
      type: "tool_status";
      callId: string;
      status: "running" | "awaiting_approval" | "completed" | "failed" | "skipped" | "cancelled";
      summary: string | null;
      output: string | null;
      error: string | null;
      file: { path: string; kind: "created" | "modified" } | null;
    }
  | { type: "done"; stopReason: string | null; outputTokens: number | null };

/** Mirrors `AppError` in src-tauri/src/error.rs. */
export interface BackendError {
  kind: string;
  message: string;
  retryable: boolean;
  status?: number;
}

export function toBackendError(e: unknown): BackendError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as BackendError;
  return { kind: "internal", message: e instanceof Error ? e.message : String(e), retryable: true };
}

type RustStatus = Omit<AiStatus, "available">;
const withAvailable = (s: RustStatus): AiStatus => ({ ...s, available: true });

export const tauriAiConfig: AiConfigService = {
  status: () => invoke<RustStatus>("ai_status").then(withAvailable),
  setApiKey: (apiKey) => invoke<RustStatus>("set_api_key", { apiKey }).then(withAvailable),
  clearApiKey: () => invoke<RustStatus>("clear_api_key").then(withAvailable),
  resolveToolApproval: (requestId, callId, approved) =>
    invoke<boolean>("resolve_tool_approval", { requestId, callId, approved }),
  listAllowedDirs: () => invoke<string[]>("list_allowed_dirs"),
  addAllowedDir: () => invoke<string[] | null>("add_allowed_dir"),
  removeAllowedDir: (path) => invoke<string[]>("remove_allowed_dir", { path }),
};

export const tauriChat: ChatService = {
  async streamChat(req, onEvent, signal) {
    const requestId = uid("req");
    let ended = false;
    const channel = new Channel<RustStreamEvent>();
    channel.onmessage = (ev) => {
      if (signal.aborted) return;
      switch (ev.type) {
        case "start":
          onEvent({ type: "start", model: ev.model });
          break;
        case "delta":
          onEvent({ type: "token", text: ev.text });
          break;
        case "tool_call":
          onEvent({ ...ev });
          break;
        case "tool_status":
          onEvent({ ...ev });
          break;
        case "done":
          ended = true;
          onEvent({ type: "done" });
          break;
      }
    };

    const onAbort = () => void invoke("chat_cancel", { requestId }).catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    onEvent({ type: "request", requestId });
    try {
      await invoke("chat_stream", {
        request: {
          requestId,
          conversationId: req.conversationId,
          messages: req.messages,
          model: req.settings.model.trim() || null,
          systemPrompt: req.settings.systemPrompt,
          permissions: req.permissions,
          maxToolRounds: req.settings.maxStepsPerTask,
          allowedApps: req.settings.allowedApps.split("\n").map((l) => l.trim()).filter(Boolean),
        },
        onEvent: channel,
      });
      if (!ended && !signal.aborted) onEvent({ type: "done" });
    } catch (e) {
      if (signal.aborted) return;
      const err = toBackendError(e);
      onEvent({ type: "error", message: err.message, kind: err.kind, retryable: err.retryable });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  },
  async loadConversations() {
    return load("conversations", []);
  },
};
