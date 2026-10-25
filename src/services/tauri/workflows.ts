import { invoke } from "@tauri-apps/api/core";
import type { Schedule, Workflow } from "../../types";
import { load, save } from "../../lib/storage";
import { isTauri } from "./tauriAi";

/** Workflow storage and planning. Persisted by the Rust backend; browser dev falls back to localStorage. */
export const workflowService = {
  load: async (): Promise<Workflow[]> =>
    isTauri() ? ((await invoke("workflows_load")) as Workflow[]) : load<Workflow[]>("workflows", []),
  save: async (workflows: Workflow[]): Promise<void> => {
    if (isTauri()) await invoke("workflows_save", { workflows });
    else save("workflows", workflows);
  },
  /** Asks the model for an ordered step list (no tools run). Needs the desktop app and an API key. */
  plan: async (goal: string, model: string): Promise<string[]> => {
    if (!isTauri()) throw new Error("Planning with AI needs the desktop app. Enter the steps yourself.");
    return (await invoke("workflow_plan", { goal, model: model.trim() || null })) as string[];
  },
};

/** Schedule storage (Rust backend; localStorage in browser dev). */
export const scheduleService = {
  load: async (): Promise<Schedule[]> =>
    isTauri() ? ((await invoke("schedules_load")) as Schedule[]) : load<Schedule[]>("schedules", []),
  save: async (schedules: Schedule[]): Promise<void> => {
    if (isTauri()) await invoke("schedules_save", { schedules });
    else save("schedules", schedules);
  },
};
