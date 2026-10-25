import type { AiStatus } from "../types";
import { mockBackend } from "./mock/mockBackend";
import { isTauri, tauriAiConfig, tauriChat } from "./tauri/tauriAi";
import type { AiConfigService, Backend } from "./types";

const unavailable: AiStatus = {
  available: false,
  provider: "openai",
  configured: false,
  source: null,
  keyHint: null,
};

/** Outside Tauri (plain `npm run dev` in a browser) there is no Rust backend. */
const browserAiConfig: AiConfigService = {
  status: async () => unavailable,
  setApiKey: async () => {
    throw { kind: "internal", message: "API keys can only be saved in the desktop app.", retryable: false };
  },
  clearApiKey: async () => unavailable,
};

/**
 * The active backend. Chat is live through the Rust backend when an API key is
 * configured; everything else (tasks, automations, local agent) is still mocked.
 */
export const backend: Backend = {
  mockChat: mockBackend.chat,
  liveChat: isTauri() ? tauriChat : null,
  ai: isTauri() ? tauriAiConfig : browserAiConfig,
  tasks: mockBackend.tasks,
  automations: mockBackend.automations,
  agent: mockBackend.agent,
};

export type * from "./types";
