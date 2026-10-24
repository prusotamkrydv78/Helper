import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Hand,
  Loader2,
  SkipForward,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { StepStatus, TaskStatus } from "../../types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/primitives";

export const TASK_STATUS: Record<
  TaskStatus,
  { label: string; tone: "accent" | "info" | "warning" | "success" | "danger" | "neutral" }
> = {
  planning: { label: "Planning", tone: "accent" },
  running: { label: "Running", tone: "info" },
  awaiting_approval: { label: "Waiting for approval", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  switch (status) {
    case "planning":
      return <Sparkles className={cn(c, "text-accent animate-pulse")} />;
    case "running":
      return <Loader2 className={cn(c, "text-info animate-spin")} />;
    case "awaiting_approval":
      return <Hand className={cn(c, "text-warning")} />;
    case "completed":
      return <CheckCircle2 className={cn(c, "text-success")} />;
    case "failed":
      return <XCircle className={cn(c, "text-danger")} />;
    case "cancelled":
      return <Ban className={cn(c, "text-fg-subtle")} />;
  }
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const s = TASK_STATUS[status];
  return (
    <Badge tone={s.tone} icon={<TaskStatusIcon status={status} className="size-3" />}>
      {s.label}
    </Badge>
  );
}

export const STEP_LABEL: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  awaiting_approval: "Needs approval",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function StepStatusIcon({ status, className }: { status: StepStatus; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  switch (status) {
    case "pending":
      return <Circle className={cn(c, "text-fg-subtle/60")} />;
    case "running":
      return <Loader2 className={cn(c, "text-info animate-spin")} />;
    case "awaiting_approval":
      return <Hand className={cn(c, "text-warning")} />;
    case "completed":
      return <CheckCircle2 className={cn(c, "text-success")} />;
    case "failed":
      return <XCircle className={cn(c, "text-danger")} />;
    case "skipped":
      return <SkipForward className={cn(c, "text-fg-subtle")} />;
    case "cancelled":
      return <CircleDashed className={cn(c, "text-fg-subtle")} />;
  }
}
