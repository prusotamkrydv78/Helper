import { useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Trash2, Info } from "lucide-react";
import type { ID, Schedule, ScheduleKind } from "../types";
import { Button } from "../components/ui/Button";
import { Badge, Field, Input, Segmented, Select } from "../components/ui/primitives";
import { useToast } from "../components/ui/overlays";
import { useWorkflows } from "../store/WorkflowStore";
import { localTimeZone, MIN_INTERVAL_MINUTES, useSchedules, type ScheduleInput } from "../store/ScheduleStore";
import { cn } from "../lib/utils";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const blank = (workflowId = ""): ScheduleInput => ({
  workflowId,
  kind: "daily",
  time: "09:00",
  date: new Date().toISOString().slice(0, 10),
  weekdays: [1, 2, 3, 4, 5],
  intervalMinutes: 60,
  missedPolicy: "skip",
  enabled: true,
});

function describe(s: Schedule | ScheduleInput): string {
  switch (s.kind) {
    case "once":
      return `Once on ${s.date} at ${s.time}`;
    case "daily":
      return `Every day at ${s.time}`;
    case "weekly":
      return `Every ${(s.weekdays ?? []).map((d) => DAYS[d]).join(", ")} at ${s.time}`;
    case "interval":
      return `Every ${s.intervalMinutes} minutes`;
  }
}

export function SchedulesSection() {
  const { workflows } = useWorkflows();
  const { schedules, error, create, update, setEnabled, remove } = useSchedules();
  const toast = useToast();
  const templates = workflows.filter((w) => !w.scheduleId);
  const [form, setForm] = useState<ScheduleInput | null>(null);
  const [editing, setEditing] = useState<ID | null>(null);
  const tz = localTimeZone();

  const guard = (fn: () => void) => {
    try {
      fn();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
      return false;
    }
  };
  const submit = () => {
    if (!form) return;
    if (!form.workflowId) return void toast("Choose a workflow.", "error");
    if (guard(() => (editing ? update(editing, form) : create(form)))) {
      setForm(null);
      setEditing(null);
    }
  };
  const set = (p: Partial<ScheduleInput>) => setForm((f) => (f ? { ...f, ...p } : f));

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <CalendarClock className="size-4" /> Schedules
        </h2>
        {!form && (
          <Button size="sm" variant="outline" disabled={!templates.length} onClick={() => setForm(blank(templates[0]?.id))}>
            New schedule
          </Button>
        )}
      </div>
      <p className="mb-3 flex gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-fg-muted">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Schedules run only while this app is open (there is no background service). Runs due while it was closed or the
        computer slept are skipped or caught up once, per schedule. Each run is a fresh copy of the workflow and still asks
        for approvals in its conversation, so unattended steps that need approval wait for you. Times use this computer's
        time zone ({tz}).
      </p>
      {error && <p className="mb-3 text-sm text-danger">Couldn't save schedules: {error}</p>}

      {form && (
        <div className="mb-4 rounded-xl border border-border bg-surface p-4">
          <Field label="Workflow">
            {(id) => (
              <Select id={id} value={form.workflowId} onChange={(e) => set({ workflowId: e.target.value })}>
                {templates.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Repeat" inline>
            {() => (
              <Segmented<ScheduleKind>
                label="Repeat"
                value={form.kind}
                onChange={(kind) => set({ kind })}
                options={[
                  { value: "once", label: "Once" },
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "interval", label: "Interval" },
                ]}
              />
            )}
          </Field>
          {form.kind === "once" && (
            <Field label="Date">{(id) => <Input id={id} type="date" value={form.date ?? ""} onChange={(e) => set({ date: e.target.value })} />}</Field>
          )}
          {form.kind === "weekly" && (
            <Field label="Days">
              {() => (
                <div className="flex flex-wrap gap-1">
                  {DAYS.map((d, i) => {
                    const on = form.weekdays?.includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        className={cn("rounded-md border px-2 py-1 text-xs", on ? "border-accent bg-accent text-accent-fg" : "border-border")}
                        onClick={() => set({ weekdays: on ? form.weekdays!.filter((x) => x !== i) : [...(form.weekdays ?? []), i].sort() })}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>
          )}
          {form.kind === "interval" ? (
            <Field label="Every (minutes)">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={MIN_INTERVAL_MINUTES}
                  value={form.intervalMinutes ?? ""}
                  onChange={(e) => set({ intervalMinutes: Number(e.target.value) })}
                />
              )}
            </Field>
          ) : (
            <Field label="Time">{(id) => <Input id={id} type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />}</Field>
          )}
          <Field label="If a run was missed" description="When the app was closed or the computer was asleep at the scheduled time.">
            {(id) => (
              <Select id={id} value={form.missedPolicy} onChange={(e) => set({ missedPolicy: e.target.value as ScheduleInput["missedPolicy"] })}>
                <option value="skip">Skip it</option>
                <option value="run_once">Run once when the app opens</option>
              </Select>
            )}
          </Field>
          <div className="flex gap-2 pt-3">
            <Button variant="primary" onClick={submit}>
              {editing ? "Save schedule" : "Create schedule"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm(null);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {schedules.map((s) => {
          const template = workflows.find((w) => w.id === s.workflowId);
          const lastRun = s.lastRunWorkflowId ? workflows.find((w) => w.id === s.lastRunWorkflowId) : undefined;
          return (
            <div key={s.id} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{template?.title ?? "Deleted workflow"}</p>
                  <p className="text-fg-muted">
                    {describe(s)} · missed runs: {s.missedPolicy === "skip" ? "skipped" : "run once"}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    Next: {s.enabled && s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
                    {s.timeZone !== tz && ` (created in ${s.timeZone}; now following ${tz})`}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    Last run: {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never"}
                    {lastRun && ` · ${lastRun.status}`}
                    {s.lastRunWorkflowId && !lastRun && " · run deleted"}
                  </p>
                  {s.lastNote && <p className="text-xs text-warning">{s.lastNote}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "active" : "paused"}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={s.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                    onClick={() => guard(() => setEnabled(s.id, !s.enabled))}
                  >
                    {s.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil className="size-3.5" />}
                    onClick={() => {
                      setEditing(s.id);
                      setForm({ ...blank(s.workflowId), ...s, enabled: true });
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} onClick={() => remove(s.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
