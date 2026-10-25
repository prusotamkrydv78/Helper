import { useEffect, useState, type ReactNode } from "react";
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
        <ApprovalsCard />
        <QuickActionsCard />
        <WorkflowsCard />
        <AccountsCard />
        <SystemCard />
        <ActivityCard />
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
