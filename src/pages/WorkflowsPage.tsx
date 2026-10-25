import { useState, type ReactNode } from "react";
import { Ban, CheckCircle2, CircleDashed, Pause, Play, RotateCcw, SkipForward, Sparkles, Trash2, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import type { Workflow, WorkflowStatus, WorkflowStepStatus } from "../types";
import { Page, PageHeader } from "../components/layout/Page";
import { Button } from "../components/ui/Button";
import { Badge, EmptyState, Field, Input, Textarea } from "../components/ui/primitives";
import { useToast } from "../components/ui/overlays";
import { useStore } from "../store/AppStore";
import { useWorkflows } from "../store/WorkflowStore";
import { SchedulesSection } from "./SchedulesSection";
import { cn, formatRelative } from "../lib/utils";

const STATUS_TONE: Record<WorkflowStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  running: "info",
  paused: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
};

const STEP_ICON: Record<WorkflowStepStatus, ReactNode> = {
  pending: <CircleDashed className="size-4 text-fg-subtle" />,
  running: <Loader2 className="size-4 animate-spin text-info" />,
  completed: <CheckCircle2 className="size-4 text-success" />,
  failed: <XCircle className="size-4 text-danger" />,
  skipped: <SkipForward className="size-4 text-fg-subtle" />,
  cancelled: <Ban className="size-4 text-fg-subtle" />,
  interrupted: <AlertTriangle className="size-4 text-warning" />,
};

export function WorkflowsPage() {
  const { workflows, loaded, saveError } = useWorkflows();
  return (
    <Page>
      <PageHeader
        title="Workflows"
        description="Multi-step tasks that run one step at a time with your normal tool permissions and approvals. Progress is saved; after a restart, interrupted steps wait for you instead of re-running."
      />
      {saveError && (
        <p className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">Couldn't save workflows: {saveError}</p>
      )}
      <CreateWorkflow />
      <SchedulesSection />
      <div className="mt-8 space-y-4">
        {loaded && workflows.length === 0 && (
          <EmptyState icon={<Sparkles className="size-5" />} title="No workflows yet" description="Describe a goal above to create one." />
        )}
        {workflows.map((w) => (
          <WorkflowCard key={w.id} wf={w} />
        ))}
      </div>
    </Page>
  );
}

function CreateWorkflow() {
  const { actions } = useWorkflows();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState("");
  const [planning, setPlanning] = useState(false);

  const plan = async () => {
    setPlanning(true);
    try {
      setSteps((await actions.plan(goal)).join("\n"));
    } catch (e) {
      toast(e && typeof e === "object" && "message" in e ? String(e.message) : "Planning failed", "error");
    } finally {
      setPlanning(false);
    }
  };
  const create = (startNow: boolean) => {
    try {
      const id = actions.create({ title, goal, steps: steps.split("\n") });
      if (startNow) actions.start(id);
      setTitle("");
      setGoal("");
      setSteps("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the workflow", "error");
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <Field label="Goal">
        {(id) => <Textarea id={id} rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Summarize the .txt files in my Reports folder into summary.md" />}
      </Field>
      <Field label="Title (optional)">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="Steps" description="One instruction per line. Edit the plan before starting.">
        {(id) => <Textarea id={id} rows={5} value={steps} onChange={(e) => setSteps(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap gap-2 pt-3">
        <Button variant="outline" icon={<Sparkles className="size-4" />} loading={planning} disabled={!goal.trim() || planning} onClick={() => void plan()}>
          Plan steps with AI
        </Button>
        <Button variant="secondary" disabled={!steps.trim()} onClick={() => create(false)}>
          Save as draft
        </Button>
        <Button variant="primary" icon={<Play className="size-4" />} disabled={!steps.trim()} onClick={() => create(true)}>
          Create and run
        </Button>
      </div>
    </section>
  );
}

function WorkflowCard({ wf }: { wf: Workflow }) {
  const { actions, activeId } = useWorkflows();
  const { actions: app } = useStore();
  const toast = useToast();
  const executing = activeId === wf.id;
  const done = wf.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
  const guard = (fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  };

  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{wf.title}</h2>
          {wf.goal && <p className="mt-0.5 text-sm text-fg-muted">{wf.goal}</p>}
          <p className="mt-1 text-xs text-fg-subtle">Updated {formatRelative(wf.updatedAt)}</p>
        </div>
        <Badge tone={STATUS_TONE[wf.status]}>
          {wf.status}
          {wf.pauseRequested ? " (pausing after this step)" : ""}
        </Badge>
      </header>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={wf.steps.length} aria-valuenow={done}>
        <div className="h-full bg-accent transition-all" style={{ width: `${(done / Math.max(wf.steps.length, 1)) * 100}%` }} />
      </div>
      <p className="mt-1 text-xs text-fg-subtle">
        {done} of {wf.steps.length} steps done
      </p>

      <ol className="mt-3 space-y-2">
        {wf.steps.map((s, i) => {
          const retryable = !executing && (s.status === "failed" || s.status === "interrupted" || s.status === "cancelled");
          return (
            <li key={s.id} className={cn("rounded-lg border border-border px-3 py-2", s.status === "running" && "border-info/40")}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5">{STEP_ICON[s.status]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {i + 1}. {s.instruction}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    {s.status}
                    {s.attempts > 1 ? ` · attempt ${s.attempts}` : ""}
                  </p>
                  {s.error && <p className="mt-1 text-xs text-danger">{s.error}</p>}
                  {s.result && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-fg-muted">{s.result}</p>}
                </div>
                {retryable && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={guard(() => actions.retryStep(wf.id, s.id))}>
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" icon={<SkipForward className="size-3.5" />} onClick={guard(() => actions.skipStep(wf.id, s.id))}>
                      Skip
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="mt-3 flex flex-wrap gap-2">
        {(wf.status === "draft" || wf.status === "paused") && (
          <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={guard(() => (wf.status === "draft" ? actions.start(wf.id) : actions.resume(wf.id)))}>
            {wf.status === "draft" ? "Start" : "Resume"}
          </Button>
        )}
        {wf.status === "running" && !wf.pauseRequested && (
          <Button size="sm" variant="outline" icon={<Pause className="size-3.5" />} onClick={guard(() => actions.pause(wf.id))}>
            Pause after this step
          </Button>
        )}
        {(wf.status === "running" || wf.status === "paused" || wf.status === "draft" || wf.status === "failed") && (
          <Button size="sm" variant="danger-ghost" icon={<Ban className="size-3.5" />} onClick={guard(() => actions.cancel(wf.id))}>
            Cancel
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => app.selectConversation(wf.conversationId)}>
          Open conversation (approvals, details)
        </Button>
        {!executing && (
          <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} onClick={guard(() => actions.remove(wf.id))}>
            Delete
          </Button>
        )}
      </footer>
    </article>
  );
}
