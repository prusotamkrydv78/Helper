import { useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Copy,
  FlaskConical,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import type { Automation, ScheduleKind } from "../types";
import { cn, formatDateTime, formatRelative, nowISO, uid } from "../lib/utils";
import { useStore } from "../store/AppStore";
import { Page, PageHeader, SearchInput } from "../components/layout/Page";
import { TASK_STATUS } from "../components/task/status";
import { Button } from "../components/ui/Button";
import { ConfirmDialog, Dialog, Menu, Tooltip, useToast } from "../components/ui/overlays";
import { Badge, EmptyState, Field, Input, Select, Skeleton, Switch, Textarea } from "../components/ui/primitives";

const SCHEDULE_LABEL: Record<ScheduleKind, string> = {
  manual: "Manual only",
  hourly: "Every hour",
  daily: "Daily",
  weekly: "Weekly (Mondays)",
};

/** Next time the schedule *would* fire. The scheduler itself isn't connected yet. */
export function nextRun(a: Automation, from = new Date()): Date | null {
  if (!a.enabled || a.schedule === "manual") return null;
  const [h, m] = a.time.split(":").map(Number);
  const d = new Date(from);
  if (a.schedule === "hourly") {
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
  }
  d.setHours(h || 0, m || 0, 0, 0);
  if (a.schedule === "daily") {
    if (d <= from) d.setDate(d.getDate() + 1);
    return d;
  }
  const delta = (8 - d.getDay()) % 7; // days until Monday
  d.setDate(d.getDate() + delta);
  if (d <= from) d.setDate(d.getDate() + 7);
  return d;
}

export function AutomationsPage() {
  const { state, actions, agent } = useStore();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);

  const q = query.trim().toLowerCase();
  const list = state.automations.filter(
    (a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
  );

  const blank = (): Automation => ({
    id: uid("auto"),
    name: "",
    description: "",
    prompt: "",
    enabled: true,
    schedule: "manual",
    time: "09:00",
    lastRunAt: null,
    lastRunTaskId: null,
    createdAt: nowISO(),
    isSample: false,
  });

  return (
    <Page>
      <PageHeader
        title="Automations"
        description="Saved workflows you can run on demand or on a schedule."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(blank())}>
            New automation
          </Button>
        }
      />

      {agent.state !== "connected" && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-warning/25 bg-warning-soft/40 px-4 py-3 text-sm">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-fg-muted">
            <span className="font-medium text-fg">Scheduler not connected.</span> Scheduled automations won't run on their
            own yet. <em>Run now</em> starts a simulated demo run you can inspect.
          </p>
        </div>
      )}

      {state.automations.length > 0 && (
        <SearchInput value={query} onChange={setQuery} placeholder="Search automations" className="mb-4 w-64" />
      )}

      {state.automationsStatus === "loading" ? (
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : state.automationsStatus === "error" ? (
        <EmptyState
          icon={<AlertTriangle className="size-5 text-danger" />}
          title="Couldn't load automations"
          description="Something went wrong while loading your saved workflows."
          action={<Button onClick={actions.reloadAutomations}>Try again</Button>}
        />
      ) : state.automations.length === 0 ? (
        <EmptyState
          icon={<Workflow className="size-5" />}
          title="No automations yet"
          description="Save a workflow you repeat often — like tidying a folder or compiling a weekly report — and run it with one click."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(blank())}>
              Create automation
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState icon={<Workflow className="size-5" />} title="No matching automations" />
      ) : (
        <ul className="grid gap-3">
          {list.map((a) => {
            const next = nextRun(a);
            const lastTask = a.lastRunTaskId ? state.tasks[a.lastRunTaskId] : undefined;
            return (
              <li
                key={a.id}
                className={cn(
                  "rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong",
                  !a.enabled && "opacity-75",
                )}
              >
                <div className="flex items-start gap-4">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-muted">
                    <Workflow className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{a.name}</h3>
                      {a.isSample && (
                        <Tooltip label="Example for previewing the design">
                          <Badge tone="neutral">Sample</Badge>
                        </Tooltip>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-fg-muted">{a.description || "No description"}</p>
                    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                      <div className="flex gap-1.5">
                        <dt className="text-fg-subtle">Schedule</dt>
                        <dd>
                          {SCHEDULE_LABEL[a.schedule]}
                          {(a.schedule === "daily" || a.schedule === "weekly") && ` at ${a.time}`}
                        </dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="text-fg-subtle">Last run</dt>
                        <dd>
                          {a.lastRunAt ? (
                            <span className="inline-flex items-center gap-1.5" title={formatDateTime(a.lastRunAt)}>
                              <FlaskConical className="size-3 text-warning" />
                              Demo run {formatRelative(a.lastRunAt)}
                              {lastTask && <span className="text-fg-subtle">· {TASK_STATUS[lastTask.status].label}</span>}
                            </span>
                          ) : (
                            <span className="text-fg-subtle">Never run</span>
                          )}
                        </dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="text-fg-subtle">Next run</dt>
                        <dd>
                          {next ? (
                            <Tooltip label="Planned time — the scheduler isn't connected, so it won't run automatically yet">
                              <span className="underline decoration-dotted underline-offset-2">{formatDateTime(next.toISOString())}</span>
                            </Tooltip>
                          ) : (
                            <span className="text-fg-subtle">{a.enabled ? "Manual" : "Disabled"}</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={a.enabled}
                      label={`${a.enabled ? "Disable" : "Enable"} ${a.name}`}
                      onChange={(enabled) => actions.saveAutomation({ ...a, enabled })}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<Play className="size-3.5" />}
                      disabled={!a.prompt.trim()}
                      onClick={() => {
                        actions.runAutomation(a.id);
                        toast("Demo run started — simulated, nothing runs on your PC", "info");
                      }}
                    >
                      Run now
                    </Button>
                    <Menu
                      items={[
                        { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(a) },
                        {
                          label: "Duplicate",
                          icon: <Copy />,
                          onSelect: () => {
                            actions.duplicateAutomation(a.id);
                            toast(`Duplicated “${a.name}”`, "success");
                          },
                        },
                        { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(a) },
                      ]}
                      trigger={(p) => (
                        <Button size="icon-sm" variant="ghost" aria-label={`Options for ${a.name}`} icon={<MoreHorizontal className="size-4" />} {...p} />
                      )}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AutomationDialog
        automation={editing}
        isNew={editing ? !state.automations.some((a) => a.id === editing.id) : false}
        onClose={() => setEditing(null)}
        onSave={(a) => {
          actions.saveAutomation(a);
          toast(`Saved “${a.name}”`, "success");
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          actions.deleteAutomation(deleting.id);
          toast(`Deleted “${deleting.name}”`, "success");
        }}
        title="Delete automation?"
        description={deleting ? `“${deleting.name}” will be permanently removed.` : undefined}
      />
    </Page>
  );
}

function AutomationDialog({
  automation,
  isNew,
  onClose,
  onSave,
}: {
  automation: Automation | null;
  isNew: boolean;
  onClose: () => void;
  onSave: (a: Automation) => void;
}) {
  const [draft, setDraft] = useState<Automation | null>(automation);
  const [touched, setTouched] = useState(false);
  if (automation && draft?.id !== automation.id) {
    setDraft(automation);
    setTouched(false);
  }
  if (!automation || !draft) return null;

  const set = <K extends keyof Automation>(k: K, v: Automation[K]) => setDraft({ ...draft, [k]: v });
  const errors = {
    name: !draft.name.trim() ? "Give the automation a name." : null,
    prompt: !draft.prompt.trim() ? "Describe what the automation should do." : null,
  };
  const valid = !errors.name && !errors.prompt;

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? "New automation" : "Edit automation"}
      description="Describe the workflow in plain language. It runs like a chat task."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setTouched(true);
              if (valid) onSave({ ...draft, name: draft.name.trim(), isSample: false });
            }}
          >
            {isNew ? "Create" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="-my-3.5 divide-y divide-border">
        <Field label="Name">
          {(id) => (
            <>
              <Input id={id} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Tidy Downloads" />
              {touched && errors.name && <p className="text-xs text-danger">{errors.name}</p>}
            </>
          )}
        </Field>
        <Field label="Description">
          {(id) => <Input id={id} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional" />}
        </Field>
        <Field label="Instructions">
          {(id) => (
            <>
              <Textarea
                id={id}
                rows={3}
                value={draft.prompt}
                onChange={(e) => set("prompt", e.target.value)}
                placeholder="e.g. Organize my Downloads folder by file type"
              />
              {touched && errors.prompt && <p className="text-xs text-danger">{errors.prompt}</p>}
            </>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Schedule">
            {(id) => (
              <Select id={id} value={draft.schedule} onChange={(e) => set("schedule", e.target.value as ScheduleKind)}>
                {(Object.keys(SCHEDULE_LABEL) as ScheduleKind[]).map((k) => (
                  <option key={k} value={k}>
                    {SCHEDULE_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Time">
            {(id) => (
              <Input
                id={id}
                type="time"
                value={draft.time}
                disabled={draft.schedule === "manual" || draft.schedule === "hourly"}
                onChange={(e) => set("time", e.target.value || "09:00")}
              />
            )}
          </Field>
        </div>
        <Field label="Enabled" description="Disabled automations can still be run manually." inline>
          {() => <Switch checked={draft.enabled} onChange={(v) => set("enabled", v)} label="Enabled" />}
        </Field>
      </div>
    </Dialog>
  );
}
