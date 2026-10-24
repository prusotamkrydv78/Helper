import { FlaskConical, PanelRightOpen, RotateCcw, Square } from "lucide-react";
import type { Task } from "../../types";
import { cn, durationBetween, formatDuration } from "../../lib/utils";
import { isTaskActive } from "../../store/reducer";
import { useStore } from "../../store/AppStore";
import { useNow } from "../../hooks/useNow";
import { Button } from "../ui/Button";
import { Badge } from "../ui/primitives";
import { Tooltip } from "../ui/overlays";
import { TaskStatusBadge } from "./status";
import { StepItem } from "./StepItem";

export function taskProgress(task: Task) {
  // Only steps that actually completed count as progress — never inflated.
  const done = task.steps.filter((s) => s.status === "completed").length;
  return { done, total: task.steps.length };
}

export function TaskProgress({ task, className }: { task: Task; className?: string }) {
  const { done, total } = taskProgress(task);
  const pct = total ? (done / total) * 100 : 0;
  const tone =
    task.status === "failed" ? "bg-danger" : task.status === "completed" ? "bg-success" : task.status === "cancelled" ? "bg-fg-subtle" : "bg-accent";
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Steps completed"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-fg-subtle tabular-nums">
        {done}/{total} completed
      </span>
    </div>
  );
}

export function TaskDuration({ task }: { task: Task }) {
  const active = isTaskActive(task);
  const now = useNow(active);
  const ms = durationBetween(task.createdAt, task.finishedAt ?? new Date(now).toISOString());
  return <span className="tabular-nums">{ms === null ? "—" : formatDuration(ms)}</span>;
}

export function TaskControls({ task, size = "sm" }: { task: Task; size?: "sm" | "md" }) {
  const { actions } = useStore();
  const active = isTaskActive(task);
  return (
    <div className="flex items-center gap-1.5">
      {active && (
        <Button size={size} variant="outline" icon={<Square className="size-3" />} onClick={() => actions.cancelTask(task.id)}>
          Cancel
        </Button>
      )}
      {(task.status === "failed" || task.status === "cancelled") && (
        <Button size={size} variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={() => actions.retryTask(task.id)}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Inline execution view rendered under the assistant message that started it. */
export function TaskCard({ task }: { task: Task }) {
  const { actions, state } = useStore();
  const panelShowing = state.ui.panelOpen && state.ui.panelTaskId === task.id;
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface animate-slide-up">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{task.title}</span>
          <TaskStatusBadge status={task.status} />
          {task.isDemo && (
            <Tooltip label="Simulated execution — no tools were actually run">
              <Badge tone="warning" icon={<FlaskConical className="size-3" />}>
                Demo
              </Badge>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-xs text-fg-subtle">
            <TaskDuration task={task} />
          </span>
          <TaskControls task={task} />
          {!panelShowing && (
            <Tooltip label="Open task details">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Open task details"
                icon={<PanelRightOpen className="size-4" />}
                onClick={() => actions.openTask(task.id)}
              />
            </Tooltip>
          )}
        </div>
      </div>
      <div className="px-3.5 pt-2.5">
        <TaskProgress task={task} />
      </div>
      <ol className="space-y-0.5 p-1.5 pt-2">
        {task.steps.map((s, i) => (
          <StepItem key={s.id} task={task} step={s} index={i} />
        ))}
      </ol>
      {task.status === "failed" && task.error && (
        <div className="border-t border-border bg-danger-soft/50 px-3.5 py-2.5 text-xs">
          <p className="font-medium text-danger">{task.error}</p>
          {task.recovery && <p className="mt-1 text-fg-muted">{task.recovery}</p>}
        </div>
      )}
      {task.status === "cancelled" && (
        <div className="border-t border-border px-3.5 py-2 text-xs text-fg-subtle">
          {task.error ?? "Task cancelled. Remaining steps were not run."}
        </div>
      )}
    </div>
  );
}
