import { useMemo, useState } from "react";
import { ChevronRight, FlaskConical, ListChecks, MessageSquare } from "lucide-react";
import type { Task } from "../types";
import { formatRelative } from "../lib/utils";
import { useStore } from "../store/AppStore";
import { isTaskActive } from "../store/reducer";
import { FilterChips, Page, PageHeader, SearchInput } from "../components/layout/Page";
import { TaskDuration, TaskControls, taskProgress } from "../components/task/TaskCard";
import { TASK_STATUS, TaskStatusIcon } from "../components/task/status";
import { Button } from "../components/ui/Button";
import { Badge, EmptyState, Skeleton } from "../components/ui/primitives";

type Filter = "all" | "active" | "awaiting_approval" | "completed" | "failed" | "cancelled";

const MATCH: Record<Filter, (t: Task) => boolean> = {
  all: () => true,
  active: isTaskActive,
  awaiting_approval: (t) => t.status === "awaiting_approval",
  completed: (t) => t.status === "completed",
  failed: (t) => t.status === "failed",
  cancelled: (t) => t.status === "cancelled",
};

function resultText(t: Task): string {
  const { done, total } = taskProgress(t);
  const skipped = t.steps.filter((s) => s.status === "skipped").length;
  switch (t.status) {
    case "completed":
      return `${total - skipped} of ${total} steps completed${skipped ? ` · ${skipped} skipped` : ""}`;
    case "failed":
      return t.error ?? "Failed";
    case "cancelled":
      return t.error ?? `Cancelled — ${done} of ${total} steps completed`;
    case "awaiting_approval":
      return "Paused until you approve the next step";
    default:
      return `${done} of ${total} steps completed`;
  }
}

export function TasksPage() {
  const { state, actions } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const all = useMemo(
    () => Object.values(state.tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.tasks],
  );
  const convTitle = (id: string) => state.conversations.find((c) => c.id === id)?.title ?? "Deleted conversation";

  const filtered = all.filter((t) => {
    const q = query.trim().toLowerCase();
    return MATCH[filter](t) && (!q || t.title.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q));
  });

  const opts: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "awaiting_approval", label: "Needs approval" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
    { value: "cancelled", label: "Cancelled" },
  ];

  return (
    <Page>
      <PageHeader
        title="Tasks"
        description="Everything the assistant has started, with its status and results."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search tasks" className="w-64" />
        <FilterChips
          value={filter}
          onChange={setFilter}
          options={opts.map((o) => ({ ...o, count: all.filter(MATCH[o.value]).length }))}
        />
      </div>

      {!state.loaded ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          title="No tasks yet"
          description="Ask the assistant to do something — like organizing a folder — and the task will be tracked here."
          action={
            <Button variant="primary" icon={<MessageSquare className="size-4" />} onClick={actions.newChat}>
              Start a chat
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          title="No matching tasks"
          description="Try a different search or filter."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {filtered.map((t) => (
            <li key={t.id} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2/50">
              <TaskStatusIcon status={t.status} />
              <button type="button" onClick={() => actions.openTask(t.id)} className="min-w-0 flex-1 cursor-pointer text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{t.title}</span>
                  {t.isDemo && (
                    <Badge tone="warning" icon={<FlaskConical className="size-3" />}>
                      Demo
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-fg-muted">{resultText(t)}</p>
                <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
                  {TASK_STATUS[t.status].label} · {formatRelative(t.createdAt)} · <TaskDuration task={t} /> · in “{convTitle(t.conversationId)}”
                </p>
              </button>
              <TaskControls task={t} />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Open ${t.title}`}
                icon={<ChevronRight className="size-4" />}
                onClick={() => actions.openTask(t.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
