import { useState } from "react";
import { Activity, Ban, Check, OctagonX, Pause, X } from "lucide-react";
import { Page, PageHeader } from "../components/layout/Page";
import { Button } from "../components/ui/Button";
import { Badge, EmptyState } from "../components/ui/primitives";
import { useToast } from "../components/ui/overlays";
import { useStore } from "../store/AppStore";
import { sideEffects, useWorkflows } from "../store/WorkflowStore";
import { useSchedules } from "../store/ScheduleStore";
import { featureService } from "../services/tauri/assistant";
import { isTaskActive } from "../store/reducer";

/**
 * One view of everything running: chat tool tasks (browser, files, desktop, mail…),
 * workflows and schedules, with progress, current action, approvals, errors and Stop.
 */
export function RunningPage() {
  const { state, actions } = useStore();
  const { workflows, activeId, actions: wf } = useWorkflows();
  const { schedules } = useSchedules();
  const toast = useToast();
  const [report, setReport] = useState<{ cancelledRequests: number; notStopped: string[] } | null>(null);

  const chatTasks = Object.values(state.tasks).filter((t) => !t.isDemo && isTaskActive(t));
  const active = workflows.find((w) => w.id === activeId);
  const needsAttention = workflows.filter((w) => w.id !== activeId && (w.status === "paused" || w.status === "failed")).slice(0, 8);
  const nextRuns = schedules.filter((s) => s.enabled && s.nextRunAt).length;
  const convTitle = (id: string) => state.conversations.find((c) => c.id === id)?.title ?? "Chat";

  const stopEverything = async () => {
    // Abort every reply/tool stream, voice and speech here; stop the workflow; then the backend
    // cancels every request, pending approval and the browser session.
    actions.stopAll();
    if (active) wf.cancel(active.id);
    const r = await featureService.stopAll().catch(() => null);
    setReport({ cancelledRequests: r?.cancelledRequests ?? 0, notStopped: r?.notStopped ?? [] });
    toast("Stop requested for everything", "info");
  };

  const nothing = chatTasks.length === 0 && !active && needsAttention.length === 0;

  return (
    <Page>
      <PageHeader
        title="Running"
        description="Everything the assistant is doing right now across chats, workflows, browser, files and apps."
        actions={
          <Button variant="danger" icon={<OctagonX className="size-4" />} onClick={() => void stopEverything()}>
            Stop everything
          </Button>
        }
      />
      {report && (
        <div className="mb-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          <p>Stopped. Cancelled {report.cancelledRequests} running request(s) in the backend.</p>
          {report.notStopped.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-warning">
              {report.notStopped.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">Nothing reported as still running.</p>
          )}
        </div>
      )}
      {nothing && <EmptyState icon={<Activity className="size-5" />} title="Nothing running" description={`${nextRuns} scheduled run(s) are waiting.`} />}

      {chatTasks.map((t) => {
        const current = t.steps.find((s) => s.status === "running");
        const waiting = t.steps.filter((s) => s.status === "awaiting_approval");
        const failed = t.steps.filter((s) => s.status === "failed");
        const done = t.steps.filter((s) => s.status === "completed").length;
        return (
          <section key={t.id} className="mb-3 rounded-xl border border-border bg-surface p-4 text-sm">
            <header className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{convTitle(t.conversationId)}</p>
                <p className="text-xs text-fg-subtle">
                  Chat task · {done}/{t.steps.length} tool calls done
                </p>
              </div>
              <div className="flex gap-1">
                <Badge tone={waiting.length ? "warning" : "info"}>{waiting.length ? "waiting for you" : "running"}</Badge>
                <Button size="sm" variant="ghost" onClick={() => actions.selectConversation(t.conversationId)}>
                  Open
                </Button>
                <Button size="sm" variant="danger-ghost" icon={<Ban className="size-3.5" />} onClick={() => actions.stopGeneration(t.conversationId)}>
                  Stop
                </Button>
              </div>
            </header>
            {current && (
              <p className="mt-2">
                Now: <span className="font-medium">{current.title}</span> {current.progress ? <span className="text-fg-muted">— {current.progress}</span> : null}
              </p>
            )}
            {waiting.map((s) => (
              <div key={s.id} className="mt-2 rounded-md border border-warning/50 bg-warning-soft px-3 py-2">
                <p className="font-medium">{s.title}</p>
                <p className="whitespace-pre-wrap text-fg-muted">{s.approvalReason || s.description}</p>
                <div className="mt-1 flex gap-2">
                  <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => actions.approveStep(t.id, s.id)}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" icon={<X className="size-3.5" />} onClick={() => actions.rejectStep(t.id, s.id)}>
                    Decline
                  </Button>
                </div>
              </div>
            ))}
            {failed.map((s) => (
              <p key={s.id} className="mt-1 text-xs text-danger">
                {s.title} failed: {s.error}
              </p>
            ))}
          </section>
        );
      })}

      {active && (
        <section className="mb-3 rounded-xl border border-border bg-surface p-4 text-sm">
          <header className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{active.title}</p>
              <p className="text-xs text-fg-subtle">
                Workflow · {active.steps.filter((s) => s.status === "completed" || s.status === "skipped").length}/{active.steps.length} steps
                {active.pauseRequested ? " · pausing after this step" : ""}
              </p>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" icon={<Pause className="size-3.5" />} onClick={() => wf.pause(active.id)}>
                Pause
              </Button>
              <Button size="sm" variant="danger-ghost" icon={<Ban className="size-3.5" />} onClick={() => wf.cancel(active.id)}>
                Cancel
              </Button>
            </div>
          </header>
          <p className="mt-2 text-xs text-fg-subtle">Goal: {active.goal || active.title}</p>
          {(() => {
            const idx = active.steps.findIndex((s) => s.status === "running");
            const runTask = Object.values(state.tasks)
              .filter((t) => t.conversationId === active.conversationId)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const recent = (runTask?.steps ?? []).filter((s) => s.status === "completed" || s.status === "failed").slice(-5);
            const now = runTask?.steps.find((s) => s.status === "running");
            return (
              <>
                <p className="mt-1">
                  {active.status === "cancelled" ? (
                    <span className="text-warning">Cancelling — waiting for the current action to stop…</span>
                  ) : (
                    <>
                      Step {idx >= 0 ? idx + 1 : "–"} of {active.steps.length}: {idx >= 0 ? active.steps[idx].instruction : "between steps"}
                    </>
                  )}
                </p>
                {now && (
                  <p className="text-xs text-fg-muted">
                    Doing: {now.title}
                    {now.progress ? ` — ${now.progress}` : ""}
                  </p>
                )}
                {recent.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-fg-subtle">Recent evidence</p>
                    <ul className="text-xs">
                      {recent.map((s) => (
                        <li key={s.id} className={s.status === "failed" ? "text-danger" : ""}>
                          {s.title}: {s.status === "failed" ? s.error : (s.result?.output ?? "").slice(0, 120) || "completed"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            );
          })()}
        </section>
      )}

      {needsAttention.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-4 text-sm">
          <p className="mb-2 font-medium">Paused or failed workflows (recoverable)</p>
          {needsAttention.map((w) => (
            <div key={w.id} className="flex items-start justify-between gap-2 py-1">
              <div className="min-w-0">
                <p>{w.title}</p>
                <p className="text-xs text-fg-muted">
                  {w.pausedReason ?? w.steps.find((s) => s.status === "failed" || s.status === "interrupted")?.error ?? w.status}
                </p>
                {(() => {
                  const bad = w.steps.find((s) => s.status === "failed" || s.status === "interrupted");
                  const n = bad ? sideEffects(bad).length : 0;
                  return bad ? (
                    <p className="text-xs text-fg-subtle">
                      {n ? `${n} action(s) in the failed step had completed — retrying asks first and may repeat them.` : "Nothing with side effects ran in the failed step; retrying is safe."}
                    </p>
                  ) : null;
                })()}
              </div>
              <Button size="sm" variant="outline" onClick={() => actions.setView("workflows")}>
                Review
              </Button>
            </div>
          ))}
        </section>
      )}
    </Page>
  );
}
