import { useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Trash2, Info, Zap } from "lucide-react";
import type { ID, Schedule, Trigger, TriggerKind, WorkflowScheduleKind } from "../types";
import { Button } from "../components/ui/Button";
import { Badge, Field, Input, Segmented, Select, Switch } from "../components/ui/primitives";
import { ConfirmDialog, useToast } from "../components/ui/overlays";
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
  const [deleting, setDeleting] = useState<ID | null>(null);
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
    if (form.action !== "reminder" && !form.workflowId) return void toast("Choose a workflow.", "error");
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
          <Button size="sm" variant="outline" onClick={() => setForm(blank(templates[0]?.id ?? ""))}>
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
          <Field label="Action">
            {(id) => (
              <Select id={id} value={form.action ?? "workflow"} onChange={(e) => set({ action: e.target.value as "workflow" | "reminder" })}>
                <option value="workflow">Run a workflow</option>
                <option value="reminder">Show a reminder</option>
              </Select>
            )}
          </Field>
          {form.action === "reminder" ? (
            <Field label="Reminder text">{(id) => <Input id={id} value={form.message ?? ""} onChange={(e) => set({ message: e.target.value })} />}</Field>
          ) : (
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
          )}
          <Field label="Repeat" inline>
            {() => (
              <Segmented<WorkflowScheduleKind>
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
                  <p className="font-medium">{s.action === "reminder" ? `Reminder: ${s.message}` : (template?.title ?? "Deleted workflow")}</p>
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
                  <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(s.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting)}
        title="Delete this schedule?"
        description="It won't run again. The workflow itself and past runs are kept."
        confirmLabel="Delete"
      />
    </section>
  );
}

const TRIGGER_KINDS: { value: TriggerKind; label: string; hint: string }[] = [
  { value: "app_started", label: "An app starts", hint: "Program file name, e.g. excel.exe" },
  { value: "battery_below", label: "Battery below", hint: "Percent, e.g. 20 (only on battery power)" },
  { value: "disk_below", label: "Free disk space below", hint: "GB, e.g. 10" },
];

const blankTrigger = (): Trigger => ({
  id: `trg-${Date.now()}`,
  name: "",
  enabled: true,
  kind: "battery_below",
  value: "20",
  action: "reminder",
  message: "",
  cooldownMinutes: 60,
});

/** Proactive triggers: opt-in, checked every 30 s while the app runs; each firing says why. */
export function TriggersSection() {
  const { workflows } = useWorkflows();
  const { triggers, saveTriggers } = useSchedules();
  const toast = useToast();
  const [draft, setDraft] = useState<Trigger | null>(null);
  const templates = workflows.filter((w) => !w.scheduleId);
  const save = (list: Trigger[]) => void saveTriggers(list).catch((e) => toast(e instanceof Error ? e.message : "Couldn't save triggers", "error"));

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <Zap className="size-4" /> Triggers
        </h2>
        {!draft && (
          <Button size="sm" variant="outline" onClick={() => setDraft(blankTrigger())}>
            New trigger
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        Triggers react to an app starting, low battery or low disk space while this app runs. They fire when the condition becomes true (not again until it
        clears and the cooldown passes) and the notification says why. A trigger can post a reminder or start a workflow; workflow actions still ask for
        approval as usual.
      </p>
      {draft && (
        <div className="mb-4 rounded-xl border border-border bg-surface p-4">
          <Field label="Name">{(id) => <Input id={id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Low battery" />}</Field>
          <Field label="When">
            {(id) => (
              <Select id={id} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as TriggerKind })}>
                {TRIGGER_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Value" description={TRIGGER_KINDS.find((k) => k.value === draft.kind)?.hint}>
            {(id) => <Input id={id} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />}
          </Field>
          <Field label="Then">
            {(id) => (
              <Select id={id} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as Trigger["action"] })}>
                <option value="reminder">Show a reminder</option>
                <option value="workflow">Start a workflow</option>
              </Select>
            )}
          </Field>
          {draft.action === "reminder" ? (
            <Field label="Reminder text">{(id) => <Input id={id} value={draft.message ?? ""} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />}</Field>
          ) : (
            <Field label="Workflow">
              {(id) => (
                <Select id={id} value={draft.workflowId ?? ""} onChange={(e) => setDraft({ ...draft, workflowId: e.target.value })}>
                  <option value="">Choose…</option>
                  {templates.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Cooldown (minutes)">
            {(id) => <Input id={id} type="number" min={1} value={draft.cooldownMinutes} onChange={(e) => setDraft({ ...draft, cooldownMinutes: Math.max(1, Number(e.target.value) || 1) })} />}
          </Field>
          <div className="flex gap-2 pt-3">
            <Button
              variant="primary"
              disabled={!draft.name.trim() || !draft.value.trim() || (draft.action === "workflow" ? !draft.workflowId : !draft.message?.trim())}
              onClick={() => {
                const clean = { ...draft, active: undefined };
                save(triggers.some((t) => t.id === draft.id) ? triggers.map((t) => (t.id === draft.id ? clean : t)) : [...triggers, clean]);
                setDraft(null);
              }}
            >
              Save trigger
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {triggers.map((t) => (
          <div key={t.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{t.name}</p>
              <p className="text-fg-muted">
                {TRIGGER_KINDS.find((k) => k.value === t.kind)?.label} {t.value} →{" "}
                {t.action === "reminder" ? `reminder “${t.message}”` : `workflow “${workflows.find((w) => w.id === t.workflowId)?.title ?? "deleted"}”`}
              </p>
              <p className="text-xs text-fg-subtle">
                Last fired: {t.lastFiredAt ? new Date(t.lastFiredAt).toLocaleString() : "never"}
                {t.lastNote ? ` · ${t.lastNote}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Switch label={`Enable ${t.name}`} checked={t.enabled} onChange={(v) => save(triggers.map((x) => (x.id === t.id ? { ...x, enabled: v, active: undefined } : x)))} />
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...t })}>
                Edit
              </Button>
              <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} onClick={() => save(triggers.filter((x) => x.id !== t.id))}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
