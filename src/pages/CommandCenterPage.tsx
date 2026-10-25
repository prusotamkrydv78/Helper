import { useEffect, useState, type ReactNode } from "react";
import { ScanEye, Sunrise } from "lucide-react";
import { ConfirmDialog } from "../components/ui/overlays";
import { featureService } from "../services/tauri/assistant";
import { Activity, AppWindow, CalendarDays, Check, Cpu, Mail, Play, RefreshCw, ShieldAlert, Workflow as WorkflowIcon, X } from "lucide-react";
import { Page, PageHeader } from "../components/layout/Page";
import { Button } from "../components/ui/Button";
import { Badge, Input, Select } from "../components/ui/primitives";
import { useToast } from "../components/ui/overlays";
import { useStore } from "../store/AppStore";
import { useWorkflows } from "../store/WorkflowStore";
import { useSchedules } from "../store/ScheduleStore";
import {
  assistantService,
  googleService,
  graphService,
  type AuditEntry,
  type GoogleStatus,
  type GraphStatus,
  type SystemStatus,
} from "../services/tauri/assistant";
import { cn } from "../lib/utils";
import { DATA_CHANGED } from "./AssistantSettings";

const ACTIVITY_POLL_MS = 10_000;
const SYSTEM_POLL_MS = 30_000;
const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Something went wrong");

function Card({ title, icon, actions, children, className }: { title: string; icon: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-surface p-4", className)}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** Central dashboard. Everything shown is live state from the stores and the Rust backend. */
export function CommandCenterPage() {
  return (
    <Page className="max-w-6xl">
      <PageHeader title="Command Center" description="Live overview of approvals, workflows, schedules, accounts, activity and this computer." />
      <div className="grid gap-4 lg:grid-cols-2">
        <BriefingCard />
        <ApprovalsCard />
        <QuickActionsCard />
        <WorkflowsCard />
        <AccountsCard />
        <SystemCard />
        <ActivityCard />
        <ScreenCard />
      </div>
    </Page>
  );
}

function ApprovalsCard() {
  const { state, actions } = useStore();
  const pending = Object.values(state.tasks).flatMap((t) =>
    t.steps.filter((s) => s.status === "awaiting_approval").map((s) => ({ task: t, step: s })),
  );
  return (
    <Card title={`Pending approvals (${pending.length})`} icon={<ShieldAlert className="size-4 text-warning" />} className={pending.length ? "border-warning/50" : undefined}>
      {pending.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing is waiting for you.</p>
      ) : (
        <ul className="space-y-2">
          {pending.map(({ task, step }) => (
            <li key={step.id} className="rounded-lg border border-border px-3 py-2 text-sm">
              <p className="font-medium">{step.title}</p>
              <p className="text-fg-muted">{step.approvalReason || step.description}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => actions.approveStep(task.id, step.id)}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" icon={<X className="size-3.5" />} onClick={() => actions.rejectStep(task.id, step.id)}>
                  Decline
                </Button>
                <Button size="sm" variant="ghost" onClick={() => actions.selectConversation(task.conversationId)}>
                  Open chat
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function QuickActionsCard() {
  const { actions } = useStore();
  const { workflows, actions: wf } = useWorkflows();
  const toast = useToast();
  const [app, setApp] = useState("");
  const [mail, setMail] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  // Task chaining: the model plans steps (no tools run); the draft opens on the Workflows page to edit and start.
  const planGoal = () => {
    const g = goal.trim();
    if (!g) return;
    setPlanning(true);
    void wf
      .plan(g)
      .then((steps) => {
        wf.create({ title: "", goal: g, steps });
        setGoal("");
        actions.setView("workflows");
        toast(`Planned ${steps.length} steps. Review and start it on the Workflows page.`, "success");
      })
      .catch((e) => toast(message(e), "error"))
      .finally(() => setPlanning(false));
  };
  const templates = workflows.filter((w) => !w.scheduleId && (w.status === "draft" || w.status === "paused"));
  // Quick actions are ordinary chat requests: the assistant uses its tools under your permissions and approvals.
  const ask = (text: string) => actions.startChat(text);
  const row = "flex gap-2";

  return (
    <Card title="Quick actions" icon={<Play className="size-4" />}>
      <div className="space-y-2 text-sm">
        <form className={row} onSubmit={(e) => (e.preventDefault(), app.trim() && ask(`Open the app "${app.trim()}" and bring it to the front.`))}>
          <Input aria-label="App to open" value={app} onChange={(e) => setApp(e.target.value)} placeholder="App name, e.g. Notepad" />
          <Button type="submit" variant="outline" icon={<AppWindow className="size-3.5" />} disabled={!app.trim()}>
            Launch
          </Button>
        </form>
        <form className={row} onSubmit={(e) => (e.preventDefault(), planGoal())}>
          <Input aria-label="Goal to plan" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal, e.g. tidy Downloads and email me a summary" />
          <Button type="submit" variant="outline" icon={<WorkflowIcon className="size-3.5" />} loading={planning} disabled={!goal.trim() || planning}>
            Plan
          </Button>
        </form>
        <form className={row} onSubmit={(e) => (e.preventDefault(), mail.trim() && ask(`Search my email for: ${mail.trim()}. Summarize what you find.`))}>
          <Input aria-label="Email search" value={mail} onChange={(e) => setMail(e.target.value)} placeholder="Search email, e.g. invoices from last week" />
          <Button type="submit" variant="outline" icon={<Mail className="size-3.5" />} disabled={!mail.trim()}>
            Search
          </Button>
        </form>
        <div className={row}>
          <Select aria-label="Workflow to start" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} className="flex-1">
            <option value="">Choose a workflow…</option>
            {templates.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title} ({w.status})
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            icon={<WorkflowIcon className="size-3.5" />}
            disabled={!workflowId}
            onClick={() => {
              try {
                wf.start(workflowId);
                setWorkflowId("");
              } catch (e) {
                toast(message(e), "error");
              }
            }}
          >
            Start
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="ghost" icon={<CalendarDays className="size-3.5" />} onClick={() => ask("What's on my calendar today and tomorrow? Mention conflicts.")}>
            Today's calendar
          </Button>
          <Button size="sm" variant="ghost" icon={<Mail className="size-3.5" />} onClick={() => ask("List my unread emails from today and summarize the important ones.")}>
            Unread email
          </Button>
          <Button size="sm" variant="ghost" icon={<Cpu className="size-3.5" />} onClick={() => ask("Check my system status. Is anything using unusual CPU, memory or disk?")}>
            Diagnose system
          </Button>
        </div>
        <p className="text-xs text-fg-subtle">These open a chat; tools run under your permissions and ask before consequential actions.</p>
      </div>
    </Card>
  );
}

function WorkflowsCard() {
  const { state, actions } = useStore();
  const { workflows, activeId } = useWorkflows();
  const { schedules } = useSchedules();
  const active = workflows.find((w) => w.id === activeId);
  const recent = workflows.filter((w) => w.status === "failed" || w.status === "paused").slice(0, 4);
  const upcoming = schedules
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))
    .slice(0, 4);
  const runningChats = Object.values(state.tasks).filter((t) => t.status === "running" || t.status === "awaiting_approval").length;

  return (
    <Card
      title="Workflows & schedules"
      icon={<WorkflowIcon className="size-4" />}
      actions={
        <Button size="sm" variant="ghost" onClick={() => actions.setView("workflows")}>
          Open
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        {active ? (
          <div>
            <p className="font-medium">Running: {active.title}</p>
            {(() => {
              const done = active.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
              const current = active.steps.find((s) => s.status === "running");
              return (
                <>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full bg-accent transition-all" style={{ width: `${(done / Math.max(active.steps.length, 1)) * 100}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {done}/{active.steps.length} done{current ? ` · now: ${current.instruction}` : ""}
                  </p>
                </>
              );
            })()}
          </div>
        ) : (
          <p className="text-fg-muted">No workflow is running.{runningChats ? ` ${runningChats} chat task(s) active.` : ""}</p>
        )}
        {recent.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-fg-subtle">Needs attention</p>
            {recent.map((w) => (
              <p key={w.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{w.title}</span>
                <Badge tone={w.status === "failed" ? "danger" : "warning"}>{w.status}</Badge>
              </p>
            ))}
          </div>
        )}
        <div>
          <p className="mb-1 text-xs font-medium text-fg-subtle">Next scheduled runs</p>
          {upcoming.length === 0 ? (
            <p className="text-fg-muted">None.</p>
          ) : (
            upcoming.map((s) => (
              <p key={s.id} className="flex justify-between gap-2">
                <span className="truncate">{workflows.find((w) => w.id === s.workflowId)?.title ?? "Deleted workflow"}</span>
                <span className="shrink-0 text-xs text-fg-muted">{new Date(s.nextRunAt!).toLocaleString()}</span>
              </p>
            ))
          )}
        </div>
      </div>
    </Card>
  );
}

function AccountsCard() {
  const toast = useToast();
  const [ms, setMs] = useState<GraphStatus | null>(null);
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState<"ms" | "google" | null>(null);
  const load = () => {
    void graphService.status().then(setMs).catch(() => setMs(null));
    void googleService.status().then(setG).catch(() => setG(null));
  };
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    window.addEventListener(DATA_CHANGED, load);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener(DATA_CHANGED, load);
    };
  }, []);
  const reconnect = (which: "ms" | "google") => {
    setBusy(which);
    const p = which === "ms" ? graphService.connect().then(setMs) : googleService.connect().then(setG);
    void p
      .then(() => toast("Connected", "success"))
      .catch((e) => toast(message(e), "error"))
      .finally(() => setBusy(null));
  };
  const rowFor = (name: string, which: "ms" | "google", s: { configured: boolean; connected: boolean; accountEmail: string | null } | null) => (
    <div className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <div className="min-w-0">
        <p className="font-medium">{name}</p>
        <p className="truncate text-xs text-fg-muted">
          {!s ? "Desktop app only" : s.connected ? s.accountEmail : s.configured ? "Not connected" : "Not configured — see Settings"}
        </p>
      </div>
      {s && s.configured && (
        <Button size="sm" variant={s.connected ? "ghost" : "primary"} loading={busy === which} disabled={busy !== null} onClick={() => reconnect(which)}>
          {s.connected ? "Reconnect" : "Connect"}
        </Button>
      )}
      {s && !s.configured && <Badge>setup needed</Badge>}
    </div>
  );
  return (
    <Card
      title="Accounts"
      icon={<Mail className="size-4" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Refresh accounts" icon={<RefreshCw className="size-3.5" />} onClick={load} />}
    >
      {rowFor("Microsoft 365", "ms", ms)}
      {rowFor("Google Workspace", "google", g)}
      {busy && <p className="text-xs text-fg-subtle">Finish signing in in your browser…</p>}
    </Card>
  );
}

function SystemCard() {
  const toast = useToast();
  const [s, setS] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (!assistantService.available) return;
    setLoading(true);
    void assistantService
      .systemStatus()
      .then(setS)
      .catch((e) => (setS(null), toast(message(e), "error")))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), SYSTEM_POLL_MS);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card
      title="This computer"
      icon={<Cpu className="size-4" />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Refresh system status" loading={loading} icon={<RefreshCw className="size-3.5" />} onClick={load} />}
    >
      {!assistantService.available ? (
        <p className="text-sm text-fg-muted">Available in the desktop app (Windows).</p>
      ) : !s ? (
        <p className="text-sm text-fg-muted">{loading ? "Reading…" : "Unavailable."}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            CPU {s.cpu_percent ?? "?"}% · Memory {s.memory?.used_percent ?? "?"}% used
            {s.memory ? ` (${Math.round(s.memory.available_mb / 1024)} GB free)` : ""} · {s.processes_total} processes
          </p>
          <p className="text-fg-muted">
            {s.drives.map((d) => `${d.drive} ${d.free_gb}/${d.total_gb} GB free`).join(" · ")}
          </p>
          <p className="text-fg-muted">Network: {s.network.route_to_internet ? `online (${s.network.local_ip})` : "no route to the internet"}</p>
          <div>
            <p className="text-xs font-medium text-fg-subtle">Top memory use</p>
            {s.top_processes_by_memory.slice(0, 5).map((p) => (
              <p key={p.pid} className="flex justify-between text-xs">
                <span>
                  {p.name} <span className="text-fg-subtle">({p.pid})</span>
                </span>
                <span>{p.memory_mb} MB</span>
              </p>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ActivityCard() {
  const { actions } = useStore();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  useEffect(() => {
    const load = () => void assistantService.auditRecent(12).then(setEntries).catch(() => {});
    load();
    const t = setInterval(load, ACTIVITY_POLL_MS);
    return () => clearInterval(t);
  }, []);
  return (
    <Card
      title="Recent activity"
      icon={<Activity className="size-4" />}
      actions={
        <Button size="sm" variant="ghost" onClick={() => actions.setView("settings")}>
          Full log
        </Button>
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-fg-muted">No tool activity yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {entries.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-fg-subtle">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="font-medium">{e.tool}</span>
              <span className={e.status === "completed" ? "text-success" : e.status === "failed" ? "text-danger" : "text-warning"}>{e.status}</span>
              <span className="truncate text-fg-muted">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One-off screen analysis, only after the user enables it; each capture is confirmed. Never continuous. */
function ScreenCard() {
  const { state, actions } = useStore();
  const toast = useToast();
  const enabled = state.settings.screenAnalysis;
  const [windows, setWindows] = useState<{ window: number; title: string }[]>([]);
  const [target, setTarget] = useState("");
  const [region, setRegion] = useState("0, 0, 1280, 720");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadWindows = () => void featureService.screenWindows().then((r) => setWindows(r.windows)).catch((e) => toast(message(e), "error"));
  const regionNums = region.split(",").map((n) => Number(n.trim()));
  const regionOk = regionNums.length === 4 && regionNums.every((n) => Number.isFinite(n));
  const run = () => {
    setBusy(true);
    setResult(null);
    const t = target === "region" ? { region: regionNums as [number, number, number, number] } : { window: Number(target) };
    void featureService
      .screenAnalyze(t, question, state.settings.model)
      .then((r) => setResult(r.analysis))
      .catch((e) => toast(message(e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <Card title="Screen analysis" icon={<ScanEye className="size-4" />}>
      {!enabled ? (
        <div className="space-y-2 text-sm">
          <p className="text-fg-muted">
            Takes one screenshot of a window or screen region when you ask, sends it to your AI model, and explains what's shown with its visible text and
            suggested next steps. Off by default; never runs continuously.
          </p>
          <Button size="sm" variant="outline" disabled={!assistantService.available} onClick={() => actions.updateSettings({ screenAnalysis: true })}>
            Enable screen analysis
          </Button>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <Select aria-label="What to capture" value={target} onFocus={loadWindows} onChange={(e) => setTarget(e.target.value)} className="flex-1">
              <option value="">Choose a window…</option>
              {windows.map((w) => (
                <option key={w.window} value={String(w.window)}>
                  {w.title}
                </option>
              ))}
              <option value="region">A screen region…</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => actions.updateSettings({ screenAnalysis: false })}>
              Disable
            </Button>
          </div>
          {target === "region" && (
            <Input aria-label="Region: x, y, width, height" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="x, y, width, height (pixels)" />
          )}
          <Input aria-label="Question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Optional question, e.g. what does this error mean?" />
          <Button size="sm" variant="primary" loading={busy} disabled={!target || busy || (target === "region" && !regionOk)} onClick={() => setConfirm(true)}>
            Analyze…
          </Button>
          {result && <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-xs">{result}</p>}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={run}
        title="Send one screenshot to the AI?"
        description="One image of the chosen window or region (everything visible in it) is sent to your AI provider for this analysis and not stored."
        confirmLabel="Capture and analyze"
      />
    </Card>
  );
}

/** The latest daily briefing (built locally from real data), with its time so it's never mistaken for fresh. */
function BriefingCard() {
  const { briefing, refreshBriefing } = useSchedules();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="Briefing"
      icon={<Sunrise className="size-4" />}
      actions={
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void refreshBriefing()
              .catch((e) => toast(message(e), "error"))
              .finally(() => setBusy(false));
          }}
        >
          Refresh now
        </Button>
      }
    >
      {!briefing ? (
        <p className="text-sm text-fg-muted">No briefing yet. Turn on the daily briefing in Settings, or refresh now.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-xs text-fg-subtle">As of {new Date(briefing.generatedAt).toLocaleString()}</p>
          {briefing.sections.map((s) => (
            <div key={s.title}>
              <p className="text-xs font-medium text-fg-subtle">{s.title}</p>
              <ul>
                {s.lines.map((l, i) => (
                  <li key={i} className="text-xs">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
