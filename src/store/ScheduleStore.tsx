import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ID, Schedule } from "../types";
import { nowISO, uid } from "../lib/utils";
import { scheduleService } from "../services/tauri/workflows";
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
}

const Ctx = createContext<ScheduleValue | null>(null);

const errorText = (e: unknown) =>
  (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)) || "Unknown error";

export function ScheduleProvider({ children }: { children: ReactNode }) {
  const { actions: wf, loaded: workflowsLoaded } = useWorkflows();
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
        if (wfRef.current.isBusy()) {
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
        try {
          const label = late > GRACE_MS ? `catch-up for ${due.toLocaleString()}` : now.toLocaleString();
          const runId = wfRef.current.runCopy(s.workflowId, label, s.id);
          await patch(s.id, { lastRunWorkflowId: runId });
        } catch (e) {
          await patch(s.id, { lastNote: `Couldn't start: ${errorText(e)}` }).catch(() => {});
        }
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      ticking.current = false;
    }
  }, [patch]);

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
    }),
    [schedules, loaded, error, commit, patch],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSchedules(): ScheduleValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSchedules must be used inside ScheduleProvider");
  return v;
}
