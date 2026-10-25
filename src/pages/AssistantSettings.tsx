import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { ConfirmDialog, useToast } from "../components/ui/overlays";
import { Field, Input, Select, Switch } from "../components/ui/primitives";
import { assistantService, googleService, graphService, type AuditEntry, type GoogleStatus, type GraphStatus, type MemoryNote } from "../services/tauri/assistant";
import { useStore } from "../store/AppStore";
import { useWorkflows } from "../store/WorkflowStore";
import { useSchedules } from "../store/ScheduleStore";
import { Section } from "./SettingsPage";

/** Fired after data is deleted so sections showing it reload. */
export const DATA_CHANGED = "jarvis:data-changed";
function useDataChanged(reload: () => void) {
  useEffect(() => {
    window.addEventListener(DATA_CHANGED, reload);
    return () => window.removeEventListener(DATA_CHANGED, reload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Something went wrong");

export function MemorySection() {
  const toast = useToast();
  const [items, setItems] = useState<MemoryNote[]>([]);
  const [text, setText] = useState("");
  const [category, setCategory] = useState("preference");
  const [confirmClear, setConfirmClear] = useState(false);
  const reload = () => void assistantService.memoryList().then(setItems).catch((e) => toast(message(e), "error"));
  useEffect(reload, []); // eslint-disable-line react-hooks/exhaustive-deps
  useDataChanged(reload);

  return (
    <Section
      id="memory"
      title="Memory"
      description="Notes the assistant keeps across conversations. It can only add or remove notes with your approval; they're sent to the AI provider as context. Don't store secrets here."
    >
      <div className="flex flex-wrap items-end gap-2 py-4">
        <div className="min-w-48 flex-1">
          <Field label="Add a note">{(id) => <Input id={id} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer summaries as bullet points" />}</Field>
        </div>
        <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="preference">Preference</option>
          <option value="project">Project</option>
          <option value="task">Ongoing task</option>
          <option value="other">Other</option>
        </Select>
        <Button
          variant="primary"
          disabled={!text.trim() || !assistantService.available}
          onClick={() =>
            void assistantService
              .memoryAdd(text, category)
              .then(() => (setText(""), reload()))
              .catch((e) => toast(message(e), "error"))
          }
        >
          Add
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="py-4 text-sm text-fg-muted">No memories yet.</p>
      ) : (
        <ul className="py-2">
          {[...items].reverse().map((m) => (
            <li key={m.id} className="flex items-start gap-2 py-1.5 text-sm">
              <span className="mt-0.5 shrink-0 rounded bg-surface-3 px-1.5 text-xs text-fg-muted">{m.category}</span>
              <span className="min-w-0 flex-1">{m.text}</span>
              <span className="shrink-0 text-xs text-fg-subtle">
                {m.source === "assistant" ? "approved in chat" : "added by you"} · {new Date(m.createdAt).toLocaleDateString()}
              </span>
              <Button
                size="icon-sm"
                variant="danger-ghost"
                aria-label="Delete memory"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => void assistantService.memoryDelete(m.id).then(reload).catch((e) => toast(message(e), "error"))}
              />
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <div className="py-3">
          <Button size="sm" variant="danger-ghost" onClick={() => setConfirmClear(true)}>
            Delete all memories
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void assistantService.memoryClear().then(reload).catch((e) => toast(message(e), "error"))}
        title="Delete all memories?"
        description="The assistant will no longer know these notes. This can't be undone."
        confirmLabel="Delete all"
      />
    </Section>
  );
}

export function ActivityLogSection() {
  const toast = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const reload = () => void assistantService.auditRecent(200).then(setEntries).catch((e) => toast(message(e), "error"));
  useEffect(reload, []); // eslint-disable-line react-hooks/exhaustive-deps
  useDataChanged(reload);

  return (
    <Section
      id="activity"
      title="Activity log"
      description="Every tool the assistant ran, declined or failed (newest first). Arguments are shortened; file contents and typed text aren't recorded."
    >
      <div className="flex gap-2 py-3">
        <Button size="sm" variant="outline" icon={<RefreshCw className="size-3.5" />} onClick={reload}>
          Refresh
        </Button>
        <Button size="sm" variant="danger-ghost" disabled={!entries.length} onClick={() => void assistantService.auditClear().then(reload).catch((e) => toast(message(e), "error"))}>
          Clear log
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="py-4 text-sm text-fg-muted">No activity recorded yet.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto py-2">
          <table className="w-full text-left text-xs">
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className="border-b border-border/50 align-top">
                  <td className="whitespace-nowrap py-1 pr-2 text-fg-subtle">{new Date(e.ts).toLocaleString()}</td>
                  <td className="py-1 pr-2 font-medium">{e.tool}</td>
                  <td className={e.status === "completed" ? "py-1 pr-2 text-success" : e.status === "failed" ? "py-1 pr-2 text-danger" : "py-1 pr-2 text-warning"}>
                    {e.status}
                  </td>
                  <td className="break-all py-1 text-fg-muted">
                    {JSON.stringify(e.args)}
                    {e.detail ? ` — ${e.detail}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function BackgroundSection() {
  const { state, actions } = useStore();
  const toast = useToast();
  const s = state.settings;
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    void assistantService.autostartGet().then(setAutostart).catch(() => setAutostart(false));
  }, []);

  return (
    <Section
      id="background"
      title="Background & notifications"
      description="Schedules and workflows run only while the app is running. Keeping it in the tray lets them continue after you close the window."
    >
      <Field inline label="Keep running in the system tray" description="Closing the window hides it to the tray. Quit from the tray icon.">
        {() => <Switch label="Keep running in the system tray" checked={s.keepInTray} onChange={(v) => actions.updateSettings({ keepInTray: v })} />}
      </Field>
      <Field inline label="Start with Windows" description="Starts hidden in the tray when you sign in.">
        {() => (
          <Switch
            label="Start with Windows"
            checked={autostart ?? false}
            disabled={autostart === null || !assistantService.available}
            onChange={(v) =>
              void assistantService
                .autostartSet(v)
                .then(setAutostart)
                .catch((e) => toast(message(e), "error"))
            }
          />
        )}
      </Field>
      <Field inline label="Notifications" description="Notify when an approval is needed or a workflow finishes while the app isn't in focus.">
        {() => <Switch label="Notifications" checked={s.notifications} onChange={(v) => actions.updateSettings({ notifications: v })} />}
      </Field>
    </Section>
  );
}

export function MicrosoftSection() {
  const toast = useToast();
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("");
  const [busy, setBusy] = useState<"save" | "connect" | "disconnect" | null>(null);
  const apply = (s: GraphStatus | null) => {
    setStatus(s);
    if (s) {
      setClientId(s.clientId);
      setTenant(s.tenant === "common" ? "" : s.tenant);
    }
  };
  useEffect(() => {
    void graphService.status().then(apply).catch(() => apply(null));
  }, []);
  useDataChanged(() => void graphService.status().then(apply).catch(() => apply(null)));
  const run = (kind: "save" | "connect" | "disconnect", p: () => Promise<GraphStatus>) => {
    setBusy(kind);
    void p()
      .then((s) => {
        apply(s);
        if (kind === "connect") toast(`Connected as ${s.accountEmail ?? s.accountName ?? "your account"}`, "success");
      })
      .catch((e) => toast(message(e), "error"))
      .finally(() => setBusy(null));
  };

  return (
    <Section
      id="microsoft"
      title="Microsoft 365"
      description="Outlook mail and calendar through Microsoft Graph. Needs your own app registration (see the README). Sign-in happens in your browser; tokens are kept in Windows Credential Manager and never shown to the AI."
    >
      {!status ? (
        <p className="py-4 text-sm text-fg-muted">Available in the desktop app.</p>
      ) : (
        <>
          <Field label="Application (client) ID" description={status.fromEnv ? "Set by MS_GRAPH_CLIENT_ID." : "From your app registration in Microsoft Entra ID."}>
            {(id) => <Input id={id} value={clientId} disabled={status.fromEnv} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />}
          </Field>
          <Field label="Tenant" description="Leave empty for “common” (work, school and personal accounts), or enter organizations, consumers, a tenant ID or domain.">
            {(id) => <Input id={id} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common" />}
          </Field>
          <div className="flex flex-wrap items-center gap-2 py-4">
            <Button variant="outline" loading={busy === "save"} disabled={busy !== null} onClick={() => run("save", () => graphService.setConfig(clientId, tenant))}>
              Save
            </Button>
            {status.connected ? (
              <Button variant="danger-ghost" loading={busy === "disconnect"} disabled={busy !== null} onClick={() => run("disconnect", graphService.disconnect)}>
                Disconnect
              </Button>
            ) : (
              <Button variant="primary" loading={busy === "connect"} disabled={busy !== null || !status.configured} onClick={() => run("connect", graphService.connect)}>
                Connect Microsoft account
              </Button>
            )}
            {busy === "connect" && (
              <Button variant="ghost" onClick={() => void graphService.cancelConnect()}>
                Cancel sign-in
              </Button>
            )}
          </div>
          <div className="py-3 text-sm">
            <p>
              Status:{" "}
              {status.connected ? (
                <span className="text-success">Connected as {status.accountName ? `${status.accountName} (${status.accountEmail})` : status.accountEmail}</span>
              ) : status.configured ? (
                "Not connected"
              ) : (
                "Not configured"
              )}
            </p>
            <p className="mt-1 text-xs text-fg-subtle">Requested permissions: {status.scopes}</p>
          </div>
        </>
      )}
    </Section>
  );
}

export function GoogleSection() {
  const toast = useToast();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "connect" | "disconnect" | null>(null);
  const apply = (s: GoogleStatus | null) => {
    setStatus(s);
    if (s) setClientId(s.clientId);
    setSecret("");
  };
  useEffect(() => {
    void googleService.status().then(apply).catch(() => apply(null));
  }, []);
  useDataChanged(() => void googleService.status().then(apply).catch(() => apply(null)));
  const run = (kind: "save" | "connect" | "disconnect", p: () => Promise<GoogleStatus>) => {
    setBusy(kind);
    void p()
      .then((s) => {
        apply(s);
        if (kind === "connect") toast(`Connected as ${s.accountEmail ?? "your Google account"}`, "success");
      })
      .catch((e) => toast(message(e), "error"))
      .finally(() => setBusy(null));
  };

  return (
    <Section
      id="google"
      title="Google Workspace"
      description="Gmail and Google Calendar. Needs your own Google Cloud OAuth client (see the README). Sign-in happens in your browser; the client secret and tokens are kept in Windows Credential Manager and never shown to the AI."
    >
      {!status ? (
        <p className="py-4 text-sm text-fg-muted">Available in the desktop app.</p>
      ) : (
        <>
          <Field label="OAuth client ID" description="Google Cloud → APIs & Services → Credentials → OAuth client (type: Desktop app).">
            {(id) => <Input id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />}
          </Field>
          <Field label="Client secret" description={status.hasClientSecret ? "Stored. Leave empty to keep it." : "Shown once when you create the client."}>
            {(id) => <Input id={id} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap items-center gap-2 py-4">
            <Button variant="outline" loading={busy === "save"} disabled={busy !== null} onClick={() => run("save", () => googleService.setConfig(clientId, secret))}>
              Save
            </Button>
            {status.connected ? (
              <Button variant="danger-ghost" loading={busy === "disconnect"} disabled={busy !== null} onClick={() => run("disconnect", googleService.disconnect)}>
                Disconnect
              </Button>
            ) : (
              <Button variant="primary" loading={busy === "connect"} disabled={busy !== null || !status.configured} onClick={() => run("connect", googleService.connect)}>
                Connect Google account
              </Button>
            )}
            {busy === "connect" && (
              <Button variant="ghost" onClick={() => void googleService.cancelConnect()}>
                Cancel sign-in
              </Button>
            )}
          </div>
          <div className="py-3 text-sm">
            <p>
              Status:{" "}
              {status.connected ? <span className="text-success">Connected as {status.accountEmail}</span> : status.configured ? "Not connected" : "Not configured"}
            </p>
            <p className="mt-1 break-all text-xs text-fg-subtle">Requested permissions: {status.scopes}</p>
          </div>
        </>
      )}
    </Section>
  );
}

type DataKind = "chats" | "workflows" | "schedules" | "memory" | "activity" | "microsoft" | "google";

/** Separate, confirmed deletion for each kind of stored data. */
export function DataSection() {
  const { state, actions } = useStore();
  const { workflows, actions: wf } = useWorkflows();
  const { schedules, clearAll: clearSchedules } = useSchedules();
  const toast = useToast();
  const [pending, setPending] = useState<DataKind | null>(null);

  const items: Record<DataKind, { label: string; detail: string; confirm: string; run: () => Promise<unknown> | void }> = {
    chats: {
      label: "Chats & tasks",
      detail: `${state.conversations.length} conversations. Stops anything running.`,
      confirm: "Every conversation and task card on this device is deleted, including workflow conversations. Workflows keep their steps and results; their next step continues in a new conversation.",
      run: () => actions.clearAllData(),
    },
    workflows: {
      label: "Workflows",
      detail: `${workflows.length} workflows and runs (workflows.json).`,
      confirm: "All workflows, their run history and their conversations are deleted. Schedules that use them will report that the workflow no longer exists.",
      run: () => wf.clearAll(),
    },
    schedules: {
      label: "Schedules",
      detail: `${schedules.length} schedules (schedules.json).`,
      confirm: "All schedules are deleted; nothing runs automatically anymore.",
      run: () => clearSchedules(),
    },
    memory: {
      label: "Memory",
      detail: "Notes the assistant keeps across conversations (memory.json).",
      confirm: "All memory notes are deleted.",
      run: () => assistantService.memoryClear(),
    },
    activity: {
      label: "Activity log",
      detail: "The audit history of tool calls (audit.log).",
      confirm: "The activity log and its rotated copy are deleted.",
      run: () => assistantService.auditClear(),
    },
    microsoft: {
      label: "Microsoft 365 connection",
      detail: "Signs out and deletes stored tokens (the client ID is kept).",
      confirm: "The Microsoft sign-in tokens are deleted from Credential Manager. Mail and calendar tools stop until you connect again.",
      run: () => graphService.disconnect(),
    },
    google: {
      label: "Google connection",
      detail: "Revokes access at Google and deletes stored tokens (client ID and secret are kept).",
      confirm: "Google access is revoked and the tokens are deleted from Credential Manager. Gmail and Calendar tools stop until you connect again.",
      run: () => googleService.disconnect(),
    },
  };
  const current = pending ? items[pending] : null;

  return (
    <Section id="data" title="Data on this device" description="Delete each kind of data separately. Settings and permissions aren't affected.">
      {(Object.keys(items) as DataKind[]).map((k) => (
        <Field key={k} inline label={items[k].label} description={items[k].detail}>
          {() => (
            <Button variant="danger-ghost" disabled={!assistantService.available && k !== "chats" && k !== "workflows" && k !== "schedules"} onClick={() => setPending(k)}>
              Delete…
            </Button>
          )}
        </Field>
      ))}
      <ConfirmDialog
        open={current !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (!current) return;
          try {
            void Promise.resolve(current.run())
              .then(() => {
                window.dispatchEvent(new Event(DATA_CHANGED));
                toast(`${current.label} deleted`, "success");
              })
              .catch((e) => toast(message(e), "error"));
          } catch (e) {
            toast(message(e), "error");
          }
        }}
        title={current ? `Delete ${current.label.toLowerCase()}?` : ""}
        description={current?.confirm ?? ""}
        confirmLabel="Delete"
      />
    </Section>
  );
}
