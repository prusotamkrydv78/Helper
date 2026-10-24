import { mockBackend } from "./mock/mockBackend";
import type { Backend } from "./types";

/**
 * The active backend. Replace with a real implementation (e.g. one that calls
 * Tauri commands or an HTTP/SSE API) once the orchestration layer exists.
 */
export const backend: Backend = mockBackend;

export type * from "./types";
