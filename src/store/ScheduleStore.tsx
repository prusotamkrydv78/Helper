import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ID, Schedule, Trigger } from "../types";
import { nowISO, uid } from "../lib/utils";
import { scheduleService, triggerService, type TriggerState } from "../services/tauri/workflows";
import { useNotifications } from "./NotificationStore";
import { useStore } from "./AppStore";
import { assistantService } from "../services/tauri/assistant";
import { load, save } from "../lib/storage";
import { useWorkflows } from "./WorkflowStore";

/**
 * Runs schedules while the app is open. Each run starts a fresh copy of the
 * scheduled workflow through the workflow engine, so permissions, approvals and
 * cancellation are unchanged and interrupted steps of earlier runs are never
 * repeated. Before a run starts, the schedule's next run time is advanced and
 * saved, so the same occurrence can't fire twice (also across restarts).
 */

const TICK_MS = 30_000;
/** A run this late (app closed, computer asleep) counts as missed. */
const GRACE_MS = 10 * 60_000;
/** While another workflow is running, a due run waits up to this long, then is skipped. */
const MAX_WAIT_MS = 60 * 60_000;
export const MIN_INTERVAL_MINUTES = 15;

export type ScheduleInput = Omit<Schedule, "id" | "nextRunAt" | "lastRunAt" | "lastRunWorkflowId" | "lastNote" | "createdAt" | "updatedAt" | "timeZone">;

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function atTime(day: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(day);
  // Local wall-clock time; JS shifts nonexistent DST times forward.
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** The first occurrence strictly after `after`, in the computer's local time; null if none. */
export function nextOccurrence(s: Pick<Schedule, "kind" | "time" | "date" | "weekdays" | "intervalMinutes" | "createdAt">, after: Date): Date | null {
  switch (s.kind) {
    case "once": {
      if (!s.date) return null;
      const [y, mo, d] = s.date.split("-").map(Number);
      const when = atTime(new Date(y, (mo || 1) - 1, d || 1), s.time);
      return when > after ? when : null;
    }
    case "daily":
    case "weekly": {
      const days = s.kind === "daily" ? [0, 1, 2, 3, 4, 5, 6] : (s.weekdays ?? []);
      if (!days.length) return null;
      for (let i = 0; i <= 7; i++) {
        const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
        const when = atTime(day, s.time);
        if (days.includes(when.getDay()) && when > after) return when;
      }
      return null;
    }
    case "interval": {
      const ms = Math.max(MIN_INTERVAL_MINUTES, s.intervalMinutes ?? 0) * 60_000;
      const anchor = new Date(s.createdAt).getTime();
      const n = Math.max(1, Math.floor((after.getTime() - anchor) / ms) + 1);
      return new Date(anchor + n * ms);
    }
  }
}

export function validateSchedule(s: ScheduleInput): string | null {
  if (s.action === "reminder" && !s.message?.trim()) return "Write the reminder text.";
  if (s.kind !== "interval" && !/^\d{2}:\d{2}$/.test(s.time)) return "Choose a time.";
  if (s.kind === "once" && !s.date) return "Choose a date.";
  if (s.kind === "weekly" && !s.weekdays?.length) return "Choose at least one weekday.";
  if (s.kind === "interval" && !((s.intervalMinutes ?? 0) >= MIN_INTERVAL_MINUTES))
    return `Repeat at most every ${MIN_INTERVAL_MINUTES} minutes.`;
  return null;
}

interface ScheduleValue {
  schedules: Schedule[];
  loaded: boolean;
  error: string | null;
  create(input: ScheduleInput): void;
  update(id: ID, input: ScheduleInput): void;
  setEnabled(id: ID, enabled: boolean): void;
  remove(id: ID): void;
  triggers: Trigger[];
  saveTriggers(list: Trigger[]): Promise<void>;
  briefing: Briefing | null;
  /** Builds a fresh briefing now. */
  refreshBriefing(): Promise<void>;
  clearAll(): Promise<void>;
}

const Ctx = createContext<ScheduleValue | null>(null);

const errorText = (e: unknown) =>
  (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)) || "Unknown error";

export function ScheduleProvider({ children }: { children: ReactNode }) {
  const { actions: wf, loaded: workflowsLoaded, workflows } = useWorkflows();
  const { state: app } = useStore();
  const appRef = useRef(app);
  appRef.current = app;
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const [briefing, setBriefing] = useState<Briefing | null>(() => load<Briefing | null>("briefing", null));
  const { push } = useNotifications();
  const pushRef = useRef(push);
  pushRef.current = push;
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const triggersRef = useRef<Trigger[]>([]);
  const saveTriggers = useCallback(async (list: Trigger[]) => {
    triggersRef.current = list;
    setTriggers(list);
    await triggerService.save(list);
  }, []);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<Schedule[]>([]);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const ticking = useRef(false);
  const wfRef = useRef(wf);
  wfRef.current = wf;

  const commit = useCallback((change: (list: Schedule[]) => Schedule[]): Promise<void> => {
    ref.current = change(ref.current);
    setSchedules(ref.current);
    const snapshot = ref.current;
    saving.current = saving.current
      .catch(() => {})
      .then(() => scheduleService.save(snapshot))
      .then(
        () => setError(null),
        (e) => {
          setError(errorText(e));
          throw e;
        },
      );
    return saving.current;
  }, []);

  const patch = useCallback(
    (id: ID, p: Partial<Schedule>) => commit((list) => list.map((s) => (s.id === id ? { ...s, ...p, updatedAt: nowISO() } : s))),
    [commit],
  );

  useEffect(() => {
    void triggerService
      .load()
      .then((t) => {
        triggersRef.current = t;
        setTriggers(t);
      })
      .catch(() => {});
    scheduleService
      .load()
      .then((list) => {
        ref.current = list;
        setSchedules(list);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoaded(true));
  }, []);

  /** Advances past `now`; one-time schedules are disabled once used. */
  const advance = (s: Schedule, now: Date): Partial<Schedule> => {
    const next = nextOccurrence(s, now);
    return { nextRunAt: next ? next.toISOString() : null, enabled: next ? s.enabled : false };
  };

  const tick = useCallback(async () => {
    if (ticking.current) return;
    ticking.current = true;
    try {
      for (const s of ref.current) {
        if (!s.enabled || !s.nextRunAt) continue;
        const now = new Date();
        const due = new Date(s.nextRunAt);
        const late = now.getTime() - due.getTime();
        if (late < 0) continue;

        if (late > GRACE_MS && s.missedPolicy === "skip") {
          await patch(s.id, { ...advance(s, now), lastNote: `Missed the run due ${due.toLocaleString()} (the app was closed or asleep).` });
          continue;
        }
        if (s.action !== "reminder" && wfRef.current.isBusy()) {
          if (late > MAX_WAIT_MS)
            await patch(s.id, { ...advance(s, now), lastNote: `Skipped the run due ${due.toLocaleString()}: another workflow was running.` });
          continue; // wait for the next tick
        }
        // Write-ahead: advance and save before starting, so this occurrence can't fire twice.
        try {
          await patch(s.id, { ...advance(s, now), lastRunAt: now.toISOString(), lastNote: undefined });
        } catch {
          continue; // not saved: don't run (could repeat after a restart)
        }
        if (s.action === "reminder") {
          pushRef.current({ kind: "reminder", title: "Reminder", body: `${s.message ?? ""}\n(Scheduled ${due.toLocaleString()})`, target: { view: "workflows" } });
          continue;
        }
        try {
          const label = late > GRACE_MS ? `catch-up for ${due.toLocaleString()}` : now.toLocaleString();
          const runId = wfRef.current.runCopy(s.workflowId, label, s.id);
          await patch(s.id, { lastRunWorkflowId: runId });
        } catch (e) {
          await patch(s.id, { lastNote: `Couldn't start: ${errorText(e)}` }).catch(() => {});
        }
      }
      await checkTriggers();
      await maybeBriefing();
    } catch (e) {
      setError(errorText(e));
    } finally {
      ticking.current = false;
    }
  }, [patch]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Assembles a briefing from real data only; unavailable sources are named, never guessed. */
  const buildBriefing = async (): Promise<Briefing> => {
    const st = appRef.current;
    const sections: BriefingSection[] = [];
    const cal = await assistantService.briefingCalendar(st.settings.briefingHours).catch((e) => e as Error);
    if (cal instanceof Error || !cal) {
      sections.push({ title: "Calendar", lines: [cal instanceof Error ? `Couldn't read calendars: ${cal.message}` : "Calendars are only available in the desktop app."] });
    } else {
      for (const a of cal.accounts) {
        if (a.status === "not_configured") continue;
        const lines =
          a.status === "ok"
            ? (a.events ?? []).length
              ? (a.events ?? []).slice(0, 15).map((e) => {
                  // Microsoft gives UTC without a zone (and 7 decimals); Google gives RFC 3339 or a date for all-day events.
                  const when = e.all_day
                    ? "All day"
                    : e.start_utc
                      ? new Date(`${e.start_utc.slice(0, 19)}Z`).toLocaleString()
                      : e.start
                        ? new Date(e.start).toLocaleString()
                        : "time unknown";
                  return `${when} — ${e.subject ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
                })
              : [`No events in the next ${st.settings.briefingHours} hours.`]
            : [a.status === "not_connected" ? "Not connected — reconnect in Settings to include it." : `Unavailable: ${a.error ?? "unknown error"}`];
        sections.push({ title: a.service, lines });
      }
    }
    const end = Date.now() + st.settings.briefingHours * 3_600_000;
    const reminders = ref.current.filter((x) => x.enabled && x.action === "reminder" && x.nextRunAt && Date.parse(x.nextRunAt) <= end);
    sections.push({ title: "Reminders", lines: reminders.length ? reminders.map((r) => `${new Date(r.nextRunAt!).toLocaleString()} — ${r.message}`) : ["None scheduled."] });
    const approvals = Object.values(st.tasks).flatMap((t) => t.steps.filter((x) => x.status === "awaiting_approval").map((x) => x.approvalReason || x.title));
    sections.push({ title: "Waiting for your approval", lines: approvals.length ? approvals : ["Nothing."] });
    const wfs = workflowsRef.current;
    const interrupted = wfs.filter((w) => w.steps.some((x) => x.status === "interrupted")).map((w) => w.title);
    const unfinished = wfs.filter((w) => !w.template && (w.status === "paused" || w.status === "failed" || w.status === "running")).map((w) => `${w.title} (${w.status})`);
    sections.push({ title: "Interrupted workflows", lines: interrupted.length ? interrupted : ["None."] });
    sections.push({ title: "Unfinished workflows", lines: unfinished.length ? unfinished : ["None."] });
    return { generatedAt: new Date().toISOString(), sections };
  };

  const refreshBriefing = useCallback(async () => {
    const b = await buildBriefing();
    setBriefing(b);
    save("briefing", b);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Once a day after the configured time (or once when the app opens later that day). */
  const maybeBriefing = async () => {
    const st = appRef.current.settings;
    if (!st.briefingEnabled) return;
    const [h, m] = st.briefingTime.split(":").map(Number);
    const due = new Date();
    due.setHours(h || 0, m || 0, 0, 0);
    const today = new Date().toDateString();
    if (Date.now() < due.getTime() || load<string>("briefingDay", "") === today) return;
    save("briefingDay", today);
    const b = await buildBriefing();
    setBriefing(b);
    save("briefing", b);
    const count = (t: string) => b.sections.find((x) => x.title === t)?.lines.filter((l) => !/^(None|Nothing)/.test(l)).length ?? 0;
    pushRef.current({
      kind: "reminder",
      title: "Your daily briefing",
      body: `${count("Waiting for your approval")} approval(s), ${count("Reminders")} reminder(s), ${count("Unfinished workflows")} unfinished workflow(s). Open the Command Center for details.`,
      target: { view: "home" },
    });
  };

  /** Evaluates enabled triggers against the current system state; fires on the change to true, after the cooldown. */
  const checkTriggers = async () => {
    const enabled = triggersRef.current.filter((t) => t.enabled);
    if (!enabled.length) return;
    const st: TriggerState | null = await triggerService.state().catch(() => null);
    if (!st) return;
    let changed = false;
    const next: Trigger[] = [];
    for (const t of triggersRef.current) {
      if (!t.enabled) {
        next.push(t);
        continue;
      }
      const reason = evaluate(t, st);
      const active = reason !== null;
      let updated: Trigger = { ...t, active };
      const cooled = !t.lastFiredAt || Date.now() - Date.parse(t.lastFiredAt) > Math.max(1, t.cooldownMinutes) * 60_000;
      if (active && !t.active && cooled) {
        updated = { ...updated, lastFiredAt: new Date().toISOString(), lastNote: reason };
        if (t.action === "workflow" && t.workflowId) {
          try {
            wfRef.current.runCopy(t.workflowId, `trigger: ${t.name}`, `trigger:${t.id}`);
            pushRef.current({ kind: "trigger", title: `Trigger “${t.name}” started a workflow`, body: `Why: ${reason}`, target: { view: "workflows" } });
          } catch (e) {
            updated.lastNote = `${reason} — couldn't start the workflow: ${errorText(e)}`;
            pushRef.current({ kind: "failed", title: `Trigger “${t.name}” couldn't run its workflow`, body: updated.lastNote, target: { view: "workflows" } });
          }
        } else {
          pushRef.current({ kind: "trigger", title: t.message?.trim() || `Trigger: ${t.name}`, body: `Why: ${reason}` });
        }
      }
      if (updated.active !== t.active || updated.lastFiredAt !== t.lastFiredAt) changed = true;
      next.push(updated);
    }
    if (changed) await saveTriggers(next).catch(() => {});
  };

  useEffect(() => {
    // Workflows must be loaded first so runs can find their template.
    if (!loaded || !workflowsLoaded) return;
    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    // Catch up promptly after the computer wakes or the window regains focus.
    const onWake = () => void tick();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [loaded, workflowsLoaded, tick]);

  const value = useMemo<ScheduleValue>(
    () => ({
      schedules,
      loaded,
      error,
      create: (input) => {
        const invalid = validateSchedule(input);
        if (invalid) throw new Error(invalid);
        const created = nowISO();
        const s: Schedule = { ...input, id: uid("sch"), timeZone: localTimeZone(), nextRunAt: null, createdAt: created, updatedAt: created };
        const next = nextOccurrence(s, new Date());
        if (!next) throw new Error("That time is already in the past.");
        void commit((list) => [{ ...s, nextRunAt: next.toISOString() }, ...list]).catch(() => {});
      },
      update: (id, input) => {
        const invalid = validateSchedule(input);
        if (invalid) throw new Error(invalid);
        const old = ref.current.find((s) => s.id === id);
        if (!old) return;
        const merged: Schedule = { ...old, ...input, timeZone: localTimeZone() };
        const next = nextOccurrence(merged, new Date());
        if (!next && input.enabled) throw new Error("That time is already in the past.");
        void patch(id, { ...input, timeZone: merged.timeZone, nextRunAt: next ? next.toISOString() : null }).catch(() => {});
      },
      setEnabled: (id, enabled) => {
        const s = ref.current.find((x) => x.id === id);
        if (!s) return;
        // Resuming starts from the next future occurrence; runs missed while paused aren't caught up.
        const next = enabled ? nextOccurrence(s, new Date()) : null;
        if (enabled && !next) throw new Error("This schedule has no future run. Edit it first.");
        void patch(id, { enabled, nextRunAt: next ? next.toISOString() : s.nextRunAt }).catch(() => {});
      },
      remove: (id) => void commit((list) => list.filter((s) => s.id !== id)).catch(() => {}),
      triggers,
      saveTriggers,
      briefing,
      refreshBriefing,
      clearAll: () => commit(() => []),
    }),
    [schedules, loaded, error, commit, patch, triggers, saveTriggers, briefing, refreshBriefing],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSchedules(): ScheduleValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSchedules must be used inside ScheduleProvider");
  return v;
}

/** The reason a trigger's condition holds right now, or null. */
function evaluate(t: Trigger, st: TriggerState): string | null {
  const v = t.value.trim();
  switch (t.kind) {
    case "app_started": {
      const exe = v.toLowerCase().endsWith(".exe") ? v.toLowerCase() : `${v.toLowerCase()}.exe`;
      return st.processes.includes(exe) ? `${exe} is running` : null;
    }
    case "battery_below": {
      const b = st.battery;
      const limit = Number(v);
      return b?.present && b.percent != null && !b.on_ac_power && b.percent < limit ? `battery at ${b.percent}% (below ${limit}%) on battery power` : null;
    }
    case "disk_below": {
      const limit = Number(v);
      const low = st.drives.find((d) => d.free_gb < limit);
      return low ? `${low.drive} has ${low.free_gb} GB free (below ${limit} GB)` : null;
    }
  }
}

export interface BriefingSection {
  title: string;
  lines: string[];
}

export interface Briefing {
  generatedAt: string;
  sections: BriefingSection[];
}
