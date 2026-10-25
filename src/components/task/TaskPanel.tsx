import { useMemo } from "react";
import {
  AlertTriangle,
  FileMinus,
  FilePen,
  FilePlus,
  FileSymlink,
  FlaskConical,
  ListChecks,
  Wrench,
  X,
} from "lucide-react";
import type { FileChangeKind, Task } from "../../types";
import { formatDateTime } from "../../lib/utils";
import { useStore } from "../../store/AppStore";
import { Button } from "../ui/Button";
import { Badge, EmptyState } from "../ui/primitives";
import { StepItem } from "./StepItem";
import { TaskControls, TaskDuration, TaskProgress } from "./TaskCard";
import { TaskStatusBadge } from "./status";

const FILE_ICON: Record<FileChangeKind, React.ReactNode> = {
  created: <FilePlus className="size-3.5 text-success" />,
  modified: <FilePen className="size-3.5 text-info" />,
  moved: <FileSymlink className="size-3.5 text-accent" />,
  deleted: <FileMinus className="size-3.5 text-danger" />,
};

function Section({ title, icon, children, count }: { title: string; icon: React.ReactNode; children: React.ReactNode; count?: number }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        {icon}
        {title}
        {count !== undefined && <span className="font-normal normal-case tracking-normal">· {count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function TaskPanel({ conversationTasks }: { conversationTasks: Task[] }) {
  const { state, actions } = useStore();
  const task = useMemo(
    () =>
      (state.ui.panelTaskId && state.tasks[state.ui.panelTaskId]) ||
      conversationTasks[conversationTasks.length - 1] ||
      null,
    [state.ui.panelTaskId, state.tasks, conversationTasks],
  );

  // Tool activity = steps that actually produced output or errors.
  const activity = task?.steps.filter((s) => s.result || s.error) ?? [];

  return (
    <aside
      aria-label="Task details"
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-bg-subtle animate-fade-in max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-pop"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold">Task details</span>
        <div className="flex items-center gap-1">
          {conversationTasks.length > 1 && (
            <select
              aria-label="Select task"
              value={task?.id ?? ""}
              onChange={(e) => actions.openTask(e.target.value)}
              className="h-7 max-w-40 cursor-pointer truncate rounded-md border border-border bg-surface px-2 text-xs outline-none"
            >
              {conversationTasks.map((t, i) => (
                <option key={t.id} value={t.id}>
                  {i + 1}. {t.title}
                </option>
              ))}
            </select>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close task details"
            icon={<X className="size-4" />}
            onClick={() => actions.togglePanel(false)}
          />
        </div>
      </header>

      {!task ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          title="No task yet"
          description="When the assistant starts a task, its plan, tool activity and results will show up here."
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <Section title="Summary" icon={<ListChecks className="size-3.5" />}>
            <div className="flex flex-wrap items-center gap-1.5">
              <TaskStatusBadge status={task.status} />
              {task.isDemo && (
                <Badge tone="warning" icon={<FlaskConical className="size-3" />}>
                  Demo · simulated
                </Badge>
              )}
            </div>
            <p className="mt-2.5 text-sm font-medium">{task.title}</p>
            <p className="mt-0.5 text-sm text-fg-muted">{task.summary}</p>
            <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-xs">
              <dt className="text-fg-subtle">Started</dt>
              <dd className="text-right">{formatDateTime(task.createdAt)}</dd>
              <dt className="text-fg-subtle">Duration</dt>
              <dd className="text-right">
                <TaskDuration task={task} />
              </dd>
              {task.finishedAt && (
                <>
                  <dt className="text-fg-subtle">Finished</dt>
                  <dd className="text-right">{formatDateTime(task.finishedAt)}</dd>
                </>
              )}
            </dl>
            <TaskProgress task={task} className="mt-3" />
            <div className="mt-3">
              <TaskControls task={task} />
            </div>
          </Section>

          {(task.status === "failed" || task.error) && (
            <Section title="Errors & recovery" icon={<AlertTriangle className="size-3.5" />}>
              <div className="rounded-lg border border-danger/25 bg-danger-soft/50 p-3 text-xs">
                <p className="font-medium text-danger">{task.error ?? "The task failed."}</p>
                {task.recovery && <p className="mt-1.5 text-fg-muted">{task.recovery}</p>}
              </div>
            </Section>
          )}

          <Section title="Execution steps" icon={<ListChecks className="size-3.5" />} count={task.steps.length}>
            <ol className="-mx-2 space-y-0.5">
              {task.steps.map((s, i) => (
                <StepItem key={s.id} task={task} step={s} index={i} dense />
              ))}
            </ol>
          </Section>

          <Section title="Files" icon={<FilePen className="size-3.5" />} count={task.files.length}>
            {task.files.length === 0 ? (
              <p className="text-xs text-fg-subtle">No files created or modified.</p>
            ) : (
              <ul className="space-y-1">
                {task.files.map((f, i) => (
                  <li key={`${f.path}-${i}`} className="flex items-center gap-2 text-xs">
                    {FILE_ICON[f.kind]}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={f.path}>
                      {f.path}
                    </span>
                    <span className="text-fg-subtle">{f.simulated ? `${f.kind} · simulated` : f.kind}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Tool activity" icon={<Wrench className="size-3.5" />} count={activity.length}>
            {activity.length === 0 ? (
              <p className="text-xs text-fg-subtle">No tool output yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {activity.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-xs">
                    <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px]">{s.tool}</code>
                    <span className="truncate text-fg-muted">{s.status === "skipped" ? "declined" : s.error ? "error" : `${s.result?.format} result`}</span>
                    {s.finishedAt && <span className="ml-auto shrink-0 text-fg-subtle">{formatDateTime(s.finishedAt)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </aside>
  );
}
