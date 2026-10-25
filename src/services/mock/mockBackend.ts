// Mock implementation of the Backend contract. Streams canned text and simulates
// task execution with timers. It never calls an AI API, never runs commands and
// never reads or writes user files.

import type { Automation, ID, Task, TaskStep } from "../../types";
import { isAbortError, nowISO, sleep, uid } from "../../lib/utils";
import { load } from "../../lib/storage";
import type { AgentService, AutomationService, ChatEvent, ChatService, TaskEvent, TaskService } from "../types";
import { chatReply, pickBlueprint, type TaskBlueprint } from "./templates";

type Listener = (e: TaskEvent) => void;

interface ApprovalWaiter {
  resolve: (approved: boolean) => void;
}

interface RunState {
  controller: AbortController;
  blueprint: TaskBlueprint;
  failAt: number | null;
}

const listeners = new Set<Listener>();
const runs = new Map<ID, RunState>();
const approvals = new Map<ID, ApprovalWaiter>(); // keyed by step id

function emit(e: TaskEvent) {
  listeners.forEach((l) => l(e));
}

function buildTask(bp: TaskBlueprint, conversationId: ID): Task {
  return {
    id: uid("task"),
    conversationId,
    title: bp.title,
    summary: bp.summary,
    status: "planning",
    isDemo: true,
    createdAt: nowISO(),
    files: [],
    steps: bp.steps.map<TaskStep>((s) => ({
      id: uid("step"),
      tool: s.tool,
      title: s.title,
      description: s.description,
      input: s.input,
      status: "pending",
      requiresApproval: Boolean(s.requiresApproval),
      risk: s.risk ?? "low",
    })),
  };
}

function waitForApproval(stepId: ID, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      approvals.delete(stepId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    approvals.set(stepId, {
      resolve: (ok) => {
        signal.removeEventListener("abort", onAbort);
        approvals.delete(stepId);
        resolve(ok);
      },
    });
  });
}

async function executeTask(task: Task): Promise<void> {
  const run = runs.get(task.id);
  if (!run) return;
  const { signal } = run.controller;
  const steps = task.steps.map((s) => ({ ...s }));
  const update = (i: number, patch: Partial<TaskStep>) => {
    steps[i] = { ...steps[i], ...patch };
    emit({ type: "step_update", taskId: task.id, step: steps[i] });
  };

  try {
    await sleep(1100, signal); // planning
    emit({ type: "task_status", taskId: task.id, status: "running" });

    for (let i = 0; i < steps.length; i++) {
      const bp = run.blueprint.steps[i];

      if (steps[i].requiresApproval) {
        update(i, { status: "awaiting_approval" });
        emit({ type: "task_status", taskId: task.id, status: "awaiting_approval" });
        const approved = await waitForApproval(steps[i].id, signal);
        emit({ type: "task_status", taskId: task.id, status: "running" });
        if (!approved) {
          update(i, { status: "skipped", finishedAt: nowISO(), error: "Rejected by user" });
          continue;
        }
      }

      update(i, { status: "running", startedAt: nowISO() });
      await sleep(bp.durationMs, signal);

      if (run.failAt === i) {
        update(i, {
          status: "failed",
          finishedAt: nowISO(),
          error: "[Simulated] Permission denied: access to the target path was refused.",
        });
        for (let j = i + 1; j < steps.length; j++) update(j, { status: "skipped" });
        emit({
          type: "task_status",
          taskId: task.id,
          status: "failed",
          error: `Step “${steps[i].title}” failed (simulated failure).`,
          recovery:
            "No changes were made after the failure. Check permissions for the target folder, then use Retry to run the task again.",
        });
        return;
      }

      update(i, { status: "completed", finishedAt: nowISO(), result: bp.result });
      bp.files?.forEach((f) =>
        emit({ type: "file_change", taskId: task.id, file: { ...f, simulated: true } }),
      );
    }

    emit({ type: "task_status", taskId: task.id, status: "completed" });
  } catch (e) {
    if (!isAbortError(e)) {
      emit({
        type: "task_status",
        taskId: task.id,
        status: "failed",
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return;
    }
    steps.forEach((s, i) => {
      if (s.status === "running" || s.status === "pending" || s.status === "awaiting_approval")
        update(i, { status: "cancelled", finishedAt: nowISO() });
    });
    emit({ type: "task_status", taskId: task.id, status: "cancelled" });
  } finally {
    runs.delete(task.id);
  }
}

function startTask(bp: TaskBlueprint, conversationId: ID, prompt: string): Task {
  const task = buildTask(bp, conversationId);
  const wantsFailure = /\b(fail|failure|error)\b/i.test(prompt);
  runs.set(task.id, {
    controller: new AbortController(),
    blueprint: bp,
    failAt: wantsFailure ? Math.max(0, bp.steps.length - 2) : null,
  });
  // Defer so the UI receives `task_started` before the first step event.
  setTimeout(() => void executeTask(task), 0);
  return task;
}

async function streamText(text: string, onEvent: (e: ChatEvent) => void, signal: AbortSignal) {
  const tokens = text.match(/\s*\S+/g) ?? [];
  for (const t of tokens) {
    await sleep(14 + Math.min(40, t.length * 3), signal);
    onEvent({ type: "token", text: t });
  }
}

const blueprintByTask = new Map<ID, { bp: TaskBlueprint; prompt: string }>();

export const mockBackend: {
  chat: ChatService;
  tasks: TaskService;
  automations: AutomationService;
  agent: AgentService;
} = {

  chat: {
    async streamChat(req, onEvent, signal) {
      const last = req.messages[req.messages.length - 1]?.content ?? "";
      try {
        await sleep(450, signal); // "thinking"
        const bp = pickBlueprint(last);
        if (bp) {
          await streamText(bp.intro, onEvent, signal);
          const task = startTask(bp, req.conversationId, last);
          blueprintByTask.set(task.id, { bp, prompt: last });
          onEvent({ type: "task_started", task });
          await streamText(`\n\n${bp.outro}`, onEvent, signal);
        } else {
          await streamText(chatReply(last), onEvent, signal);
        }
        onEvent({ type: "done" });
      } catch (e) {
        if (isAbortError(e)) return;
        onEvent({ type: "error", message: e instanceof Error ? e.message : "Stream failed" });
      }
    },
    async loadConversations() {
      await sleep(120);
      return load("conversations", []);
    },
  },

  tasks: {
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    async approveStep(_taskId, stepId) {
      approvals.get(stepId)?.resolve(true);
    },
    async rejectStep(_taskId, stepId) {
      approvals.get(stepId)?.resolve(false);
    },
    async cancelTask(taskId) {
      runs.get(taskId)?.controller.abort();
    },
    async retryTask(task) {
      const meta = blueprintByTask.get(task.id);
      const bp = meta?.bp ?? pickBlueprint(task.title) ?? pickBlueprint("organize downloads")!;
      // Retries run without the injected failure so recovery can be previewed.
      const next = startTask(bp, task.conversationId, "");
      blueprintByTask.set(next.id, { bp, prompt: "" });
      return next;
    },
  },

  automations: {
    async list() {
      await sleep(200);
      return load<Automation[] | null>("automations", null) ?? sampleAutomations();
    },
    async save(a) {
      return a;
    },
    async remove() {},
    async runNow(a, conversationId) {
      const bp = pickBlueprint(a.prompt) ?? pickBlueprint("automate workflow")!;
      const task = startTask({ ...bp, title: a.name }, conversationId, a.prompt);
      blueprintByTask.set(task.id, { bp, prompt: a.prompt });
      return task;
    },
  },

  agent: {
    async checkConnection() {
      await sleep(900);
      return {
        state: "not_installed",
        checkedAt: nowISO(),
        detail:
          "No local executor is installed. Desktop automation is unavailable until a permission-controlled agent is added.",
      };
    },
  },
};

export function sampleAutomations(): Automation[] {
  const created = new Date(Date.now() - 6 * 86_400_000).toISOString();
  return [
    {
      id: uid("auto"),
      name: "Tidy Downloads",
      description: "Sort new files in Downloads into folders by type.",
      prompt: "Organize my Downloads folder",
      enabled: true,
      schedule: "daily",
      time: "18:00",
      lastRunAt: null,
      lastRunTaskId: null,
      createdAt: created,
      isSample: true,
    },
    {
      id: uid("auto"),
      name: "Weekly research digest",
      description: "Research industry news and save a Markdown report.",
      prompt: "Research industry news and create a report",
      enabled: false,
      schedule: "weekly",
      time: "09:00",
      lastRunAt: null,
      lastRunTaskId: null,
      createdAt: created,
      isSample: true,
    },
    {
      id: uid("auto"),
      name: "Sales sheet summary",
      description: "Analyze the latest sales spreadsheet and highlight trends.",
      prompt: "Analyze the sales spreadsheet",
      enabled: true,
      schedule: "manual",
      time: "09:00",
      lastRunAt: null,
      lastRunTaskId: null,
      createdAt: created,
      isSample: true,
    },
  ];
}
