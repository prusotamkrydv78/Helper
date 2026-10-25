import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, ShieldAlert, Terminal, X } from "lucide-react";
import type { RiskLevel, Task, TaskStep } from "../../types";
import { cn, durationBetween, formatDuration } from "../../lib/utils";
import { useStore } from "../../store/AppStore";
import { Button } from "../ui/Button";
import { Badge } from "../ui/primitives";
import { STEP_LABEL, StepStatusIcon } from "./status";
import { useNow } from "../../hooks/useNow";

const RISK: Record<RiskLevel, { label: string; tone: "neutral" | "warning" | "danger" }> = {
  low: { label: "Low risk", tone: "neutral" },
  medium: { label: "Medium risk", tone: "warning" },
  high: { label: "High risk", tone: "danger" },
};

/** `dense` is for narrow containers: the tool name moves into the expanded details. */
export function StepItem({ task, step, index, dense }: { task: Task; step: TaskStep; index: number; dense?: boolean }) {
  const awaiting = step.status === "awaiting_approval";
  const [open, setOpen] = useState(false);
  const expanded = open || awaiting;
  const hasDetails = Boolean(step.input || step.result || step.error || dense);
  const now = useNow(step.status === "running");
  const dur = durationBetween(step.startedAt, step.finishedAt ?? (step.status === "running" ? new Date(now).toISOString() : undefined));

  return (
    <li
      className={cn(
        "rounded-lg border transition-colors",
        awaiting ? "border-warning/40 bg-warning-soft/40" : "border-transparent",
        expanded && !awaiting && "border-border bg-bg-subtle",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasDetails && !awaiting}
        aria-expanded={expanded}
        className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2/60 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <StepStatusIcon status={step.status} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", step.status === "pending" ? "text-fg-muted" : "text-fg")}>
            <span className="mr-1.5 text-fg-subtle tabular-nums">{index + 1}.</span>
            {step.title}
          </span>
          <span className="block truncate text-xs text-fg-subtle">{step.description}</span>
        </span>
        {!dense && (
          <code className="hidden shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted sm:block">
            {step.tool}
          </code>
        )}
        <span className="w-14 shrink-0 text-right text-[11px] text-fg-subtle tabular-nums">
          {dur !== null ? formatDuration(dur) : STEP_LABEL[step.status]}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-fg-subtle transition-transform",
            expanded && "rotate-90",
            !hasDetails && !awaiting && "invisible",
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3 px-2 pb-3 pl-8.5 pt-1 animate-fade-in">
          {dense && (
            <p className="text-[11px] text-fg-subtle">
              Tool <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">{step.tool}</code>
            </p>
          )}
          {awaiting && <ApprovalPrompt task={task} step={step} />}
          {step.input && (
            <DetailBlock label="Input">
              <pre className="whitespace-pre-wrap">{JSON.stringify(step.input, null, 2)}</pre>
            </DetailBlock>
          )}
          {step.result && (
            <DetailBlock label="Tool output" icon={<Terminal className="size-3" />} note={task.isDemo ? "simulated" : undefined}>
              <pre className="whitespace-pre-wrap">{step.result.output}</pre>
            </DetailBlock>
          )}
          {step.error && (
            <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span>{step.error}</span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DetailBlock({
  label,
  icon,
  note,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-fg-muted">
        {icon}
        {label}
        {note && <span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-warning">{note}</span>}
      </div>
      <div className="max-h-56 overflow-auto bg-code-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-muted">
        {children}
      </div>
    </div>
  );
}

export function ApprovalPrompt({ task, step }: { task: Task; step: TaskStep }) {
  const { actions } = useStore();
  const risk = RISK[step.risk];
  return (
    <div className="rounded-lg border border-warning/30 bg-surface p-3 animate-slide-up">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">Approval required</p>
            <Badge tone={risk.tone}>{risk.label}</Badge>
            {task.isDemo ? (
              <Badge tone="neutral">Demo — nothing will run</Badge>
            ) : (
              <Badge tone="warning">{step.tool.startsWith("browser_") ? "Acts on a real website" : "Changes files on your PC"}</Badge>
            )}
          </div>
          {task.isDemo ? (
            <p className="mt-1 text-sm text-fg-muted">
              The assistant wants to use <code className="font-mono text-fg">{step.tool}</code> to{" "}
              {step.description.charAt(0).toLowerCase() + step.description.slice(1)}.
            </p>
          ) : (
            <p className="mt-1 text-sm text-fg-muted">
              {step.approvalReason ? (
                <span className="font-medium text-fg">{step.approvalReason}.</span>
              ) : (
                <>
                  The assistant wants to run <span className="font-medium text-fg">{step.title}</span> on{" "}
                  <code className="break-all font-mono text-fg">{step.description}</code>.
                </>
              )}{" "}
              Review the input below before approving.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={<Check className="size-3.5" />}
              onClick={() => actions.approveStep(task.id, step.id)}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<X className="size-3.5" />}
              onClick={() => actions.rejectStep(task.id, step.id)}
            >
              Skip step
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={() => actions.cancelTask(task.id)}>
              Cancel task
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
