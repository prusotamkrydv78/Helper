import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { ConfirmDialog, useToast } from "../components/ui/overlays";
import { Field, Input, Select, Switch } from "../components/ui/primitives";
import {
  assistantService,
  featureService,
  googleService,
  graphService,
  type AuditEntry,
  type ClipHistoryView,
  type GoogleStatus,
  type GraphStatus,
  type MemoryNote,
  type OrganizeRule,
  type UndoEntry,
  type LayoutWindow,
  type LayoutPreviewRow,
  type DocResult,
} from "../services/tauri/assistant";
import { backend } from "../services";
import type { Settings } from "../types";
import { speak, stopSpeaking, voices } from "../lib/speech";
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
      description="Preferences, reusable instructions, preferred apps and context the assistant keeps across conversations. It can only add or remove notes with your approval and never saves sensitive personal details on its own; enabled notes are sent to the AI provider as context. Disable a note to keep it without using it. Don't store secrets here."
    >
      <div className="flex flex-wrap items-end gap-2 py-4">
        <div className="min-w-48 flex-1">
          <Field label="Add a note">{(id) => <Input id={id} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer summaries as bullet points" />}</Field>
        </div>
        <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="preference">Preference</option>
          <option value="instruction">Reusable instruction</option>
          <option value="app">Preferred app</option>
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
              <span className={m.enabled ? "min-w-0 flex-1" : "min-w-0 flex-1 text-fg-subtle line-through"}>{m.text}</span>
              <Switch
                label={m.enabled ? "In use" : "Disabled"}
                checked={m.enabled}
                onChange={(v) => void assistantService.memoryUpdate(m.id, { enabled: v }).then(reload).catch((e) => toast(message(e), "error"))}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const next = window.prompt("Edit memory", m.text);
                  if (next !== null && next.trim() && next !== m.text) void assistantService.memoryUpdate(m.id, { text: next }).then(reload).catch((e) => toast(message(e), "error"));
                }}
              >
                Edit
              </Button>
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

type DataKind = "chats" | "workflows" | "schedules" | "memory" | "activity" | "clipboard" | "microsoft" | "google";

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
    clipboard: {
      label: "Clipboard history",
      detail: "Items kept in memory while history is on (never on disk).",
      confirm: "All clipboard history items, pinned ones included, are forgotten. Your current clipboard isn't changed.",
      run: () => featureService.clipClear(),
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

export function ClipboardSection() {
  const { state, actions } = useStore();
  const toast = useToast();
  const on = state.settings.clipboardHistory;
  const [view, setView] = useState<ClipHistoryView | null>(null);
  const [query, setQuery] = useState("");
  const reload = () => void featureService.clipHistory(query).then(setView).catch(() => setView(null));
  useEffect(reload, [on, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [on, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useDataChanged(reload);
  const act = (p: Promise<unknown>) => void p.then(reload).catch((e) => toast(message(e), "error"));

  return (
    <Section
      id="clipboard"
      title="Clipboard history"
      description="Off by default. When on, copied text and images are kept in memory only (never saved to disk) and forgotten when you turn it off or quit. Content that apps mark as private (password managers) is never captured; text that looks like a password, key or card number is skipped. The assistant can only search it with the Clipboard permission, and asks every time."
    >
      <Field inline label="Keep clipboard history" description="Up to 50 items and 5 images; pinned items stay until deleted.">
        {() => <Switch label="Keep clipboard history" checked={on} disabled={!assistantService.available} onChange={(v) => actions.updateSettings({ clipboardHistory: v })} />}
      </Field>
      {on && view && (
        <div className="space-y-2 py-3">
          <div className="flex gap-2">
            <Input aria-label="Search clipboard history" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" />
            <Button variant="danger-ghost" onClick={() => act(featureService.clipClear())}>
              Clear
            </Button>
          </div>
          {view.skippedSensitive > 0 && <p className="text-xs text-fg-subtle">{view.skippedSensitive} item(s) skipped because they looked sensitive.</p>}
          {view.items.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing copied yet.</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {view.items.map((i) => (
                <li key={i.id} className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
                  <div className="min-w-0 flex-1">
                    {i.kind === "text" ? (
                      <p className="line-clamp-2 whitespace-pre-wrap break-words">{i.text}</p>
                    ) : i.preview ? (
                      <img src={i.preview} alt={`Copied image ${i.width}×${i.height}`} className="max-h-24 rounded" />
                    ) : (
                      <p className="text-fg-muted">
                        Image {i.width}×{i.height}
                      </p>
                    )}
                    <p className="text-[11px] text-fg-subtle">
                      {new Date(i.at).toLocaleTimeString()}
                      {i.pinned ? " · pinned" : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => act(featureService.clipRestore(i.id).then(() => toast("Copied back to the clipboard", "success")))}>
                    Copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act(featureService.clipPin(i.id, !i.pinned))}>
                    {i.pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button size="icon-sm" variant="danger-ghost" aria-label="Delete item" icon={<Trash2 className="size-3.5" />} onClick={() => act(featureService.clipDelete(i.id))} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

const newRule = (): OrganizeRule => ({ id: `rule-${Date.now()}`, name: "", path: "", by: "extension" });

export function FileRulesSection() {
  const toast = useToast();
  const [rules, setRules] = useState<OrganizeRule[]>([]);
  const [draft, setDraft] = useState<OrganizeRule | null>(null);
  const [preview, setPreview] = useState<{ rule: OrganizeRule; text: string } | null>(null);
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [undoPreview, setUndoPreview] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => {
    void featureService.rulesLoad().then(setRules).catch(() => {});
    void featureService.undoList().then(setUndo).catch(() => {});
  };
  useEffect(reload, []);
  const save = (next: OrganizeRule[]) => void featureService.rulesSave(next).then(() => setRules(next)).catch((e) => toast(message(e), "error"));
  const run = <T,>(p: Promise<T>, done: (v: T) => void) => {
    setBusy(true);
    void p
      .then(done)
      .catch((e) => toast(message(e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <Section
      id="rules"
      title="File rules"
      description="Saved rules that sort a folder's files into subfolders (by type, date or your own pattern). Applying always shows every move first and asks; changes can be undone below. The assistant can use the same organizing with your file permissions."
    >
      <ul className="py-2">
        {rules.length === 0 && <li className="py-2 text-sm text-fg-muted">No rules yet.</li>}
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{r.name || "Unnamed rule"}</span>
              <span className="text-fg-muted">
                {" "}
                · {r.path} · by {r.by === "pattern" ? `pattern “${r.target}”` : r.by}
                {r.extensions?.length ? ` · ${r.extensions.join(", ")}` : ""}
                {r.pattern ? ` · ${r.pattern}` : ""}
              </span>
            </span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(featureService.rulePreview(r), (text) => setPreview({ rule: r, text }))}>
              Preview & apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...r })}>
              Edit
            </Button>
            <Button size="icon-sm" variant="danger-ghost" aria-label="Delete rule" icon={<Trash2 className="size-3.5" />} onClick={() => save(rules.filter((x) => x.id !== r.id))} />
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="space-y-1 py-3">
          <Field label="Name">{(id) => <Input id={id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Sort downloads" />}</Field>
          <Field label="Folder" description="Full path inside an allowed folder.">
            {(id) => <Input id={id} value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} placeholder="C:\Users\me\Downloads" />}
          </Field>
          <Field label="Sort by">
            {(id) => (
              <Select id={id} value={draft.by} onChange={(e) => setDraft({ ...draft, by: e.target.value as OrganizeRule["by"] })}>
                <option value="extension">File type (extension)</option>
                <option value="year">Year modified</option>
                <option value="month">Month modified</option>
                <option value="pattern">Custom folder pattern</option>
              </Select>
            )}
          </Field>
          {draft.by === "pattern" && (
            <Field label="Target folder pattern" description="Tokens: {ext} {year} {month} {date} {name}. Example: Photos/{year}/{month}">
              {(id) => <Input id={id} value={draft.target ?? ""} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />}
            </Field>
          )}
          <Field label="Only extensions (optional)" description="Comma-separated, e.g. jpg, png">
            {(id) => (
              <Input
                id={id}
                value={(draft.extensions ?? []).join(", ")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    extensions: e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            )}
          </Field>
          <Field label="Name pattern (optional)" description="e.g. invoice* or *.pdf">
            {(id) => <Input id={id} value={draft.pattern ?? ""} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} />}
          </Field>
          <div className="flex gap-2 pt-2">
            <Button
              variant="primary"
              disabled={!draft.path.trim() || (draft.by === "pattern" && !draft.target?.trim())}
              onClick={() => {
                save(rules.some((r) => r.id === draft.id) ? rules.map((r) => (r.id === draft.id ? draft : r)) : [...rules, draft]);
                setDraft(null);
              }}
            >
              Save rule
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="py-3">
          <Button size="sm" variant="outline" disabled={!assistantService.available} onClick={() => setDraft(newRule())}>
            New rule
          </Button>
        </div>
      )}
      <div className="py-3">
        <p className="mb-1 text-sm font-medium">Undo history</p>
        {undo.length === 0 ? (
          <p className="text-sm text-fg-muted">No recent moves, renames or organizing to undo.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {undo.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {u.label} <span className="text-fg-subtle">· {new Date(u.at).toLocaleString()}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(featureService.undoPreview(u.id), (text) => setUndoPreview({ id: u.id, text }))}>
                  Undo…
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        onConfirm={() =>
          preview &&
          run(featureService.ruleApply(preview.rule), (r) => {
            toast(`Moved ${r.moved} file(s)${r.failed ? `, ${r.failed} failed` : ""}`, r.failed ? "error" : "success");
            reload();
          })
        }
        title="Apply this rule?"
        description={<span className="block max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{preview?.text}</span>}
        confirmLabel="Move files"
      />
      <ConfirmDialog
        open={undoPreview !== null}
        onClose={() => setUndoPreview(null)}
        onConfirm={() =>
          undoPreview &&
          run(featureService.undoApply(undoPreview.id), (r) => {
            toast(`Moved ${r.moved} file(s) back${r.failed ? `, ${r.failed} failed` : ""}`, r.failed ? "error" : "success");
            reload();
          })
        }
        title="Undo these changes?"
        description={<span className="block max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{undoPreview?.text}</span>}
        confirmLabel="Move back"
      />
    </Section>
  );
}

const SHORTCUT_LABELS: Record<keyof Settings["shortcuts"], string> = {
  summon: "Show JARVIS",
  voice: "Start voice input",
  pause: "Pause the running workflow",
  stop: "Stop all automation",
};

export function ShortcutsSection() {
  const { state, actions } = useStore();
  const s = state.settings;
  const [draft, setDraft] = useState(s.shortcuts);
  useEffect(() => setDraft(s.shortcuts), [s.shortcuts]);
  return (
    <Section
      id="shortcuts"
      title="Global shortcuts"
      description="Work anywhere in Windows while the app runs (also from the tray). Format: CommandOrControl+Alt+J. Shortcuts already used by another app can't be registered. Ctrl+Alt acts like AltGr on some keyboard layouts."
    >
      <Field inline label="Enable global shortcuts">
        {() => <Switch label="Enable global shortcuts" checked={s.globalShortcuts} disabled={!assistantService.available} onChange={(v) => actions.updateSettings({ globalShortcuts: v })} />}
      </Field>
      {(Object.keys(SHORTCUT_LABELS) as (keyof Settings["shortcuts"])[]).map((k) => (
        <Field key={k} inline label={SHORTCUT_LABELS[k]}>
          {(id) => <Input id={id} className="w-64" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} placeholder="(none)" />}
        </Field>
      ))}
      <div className="py-3">
        <Button size="sm" variant="outline" onClick={() => actions.updateSettings({ shortcuts: draft })}>
          Save shortcuts
        </Button>
      </div>
    </Section>
  );
}

export function VoiceSection() {
  const { state, actions } = useStore();
  const s = state.settings;
  const [voiceList, setVoiceList] = useState<SpeechSynthesisVoice[]>(voices());
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const update = () => setVoiceList(voices());
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return (
    <Section
      id="voice"
      title="Voice"
      description="Push-to-talk uses Windows speech recognition (needs a microphone and Settings → Privacy & security → Speech → Online speech recognition). Audio isn't stored by this app. Replies are read with the voices installed in Windows."
    >
      <Field inline label="Voice input" description="Shows a microphone button in the chat box; click to talk, click again to cancel.">
        {() => <Switch label="Voice input" checked={s.voiceInput} disabled={!assistantService.available} onChange={(v) => actions.updateSettings({ voiceInput: v })} />}
      </Field>
      <Field inline label="Send immediately" description="Send recognized speech without editing it first.">
        {() => <Switch label="Send immediately" checked={s.autoSendVoice} onChange={(v) => actions.updateSettings({ autoSendVoice: v })} />}
      </Field>
      <Field inline label="Read replies aloud" description="Speaking stops when you talk, send a message or press Stop.">
        {() => (
          <Switch
            label="Read replies aloud"
            checked={s.speakReplies}
            onChange={(v) => {
              if (!v) stopSpeaking();
              actions.updateSettings({ speakReplies: v });
            }}
          />
        )}
      </Field>
      <Field label="Voice">
        {(id) => (
          <Select id={id} value={s.voiceName} onChange={(e) => actions.updateSettings({ voiceName: e.target.value })}>
            <option value="">System default</option>
            {voiceList.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={`Speed (${s.speechRate.toFixed(1)}×)`}>
        {(id) => (
          <input id={id} type="range" min={0.5} max={2} step={0.1} value={s.speechRate} onChange={(e) => actions.updateSettings({ speechRate: Number(e.target.value) })} className="w-full" />
        )}
      </Field>
      <div className="py-3">
        <Button size="sm" variant="outline" onClick={() => speak("Hello, I'm your assistant. This is how I sound.", s.voiceName, s.speechRate)}>
          Test voice
        </Button>
      </div>
    </Section>
  );
}

interface SavedLayout {
  name: string;
  windows: LayoutWindow[];
}

/** Named window layouts: capture the open windows, preview, then arrange. */
export function WorkspacesSection() {
  const { state } = useStore();
  const toast = useToast();
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ layout: SavedLayout; rows: LayoutPreviewRow[] } | null>(null);
  const [launchMissing, setLaunchMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void featureService.layoutsLoad().then(setLayouts).catch(() => {});
  }, []);
  const save = (next: SavedLayout[]) => void featureService.layoutsSave(next).then(() => setLayouts(next)).catch((e) => toast(message(e), "error"));
  const allowed = state.settings.allowedApps.split("\n").map((l) => l.trim()).filter(Boolean);

  return (
    <Section
      id="workspaces"
      title="Workspaces"
      description="Save the positions of your open windows under a name and restore them later. Restoring shows what will move first. Missing apps are only reported, or launched if they're on your allowed-apps list. Virtual desktops can't be restored (Windows only lets apps move their own windows between desktops)."
    >
      <div className="flex gap-2 py-4">
        <Input aria-label="Layout name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Writing" />
        <Button
          variant="primary"
          disabled={!name.trim() || busy || !assistantService.available}
          onClick={() => {
            setBusy(true);
            void featureService
              .layoutCapture()
              .then((windows) => {
                save([...layouts.filter((l) => l.name !== name.trim()), { name: name.trim(), windows }]);
                toast(`Saved ${windows.length} windows as “${name.trim()}”`, "success");
                setName("");
              })
              .catch((e) => toast(message(e), "error"))
              .finally(() => setBusy(false));
          }}
        >
          Save current windows
        </Button>
      </div>
      {layouts.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">No saved layouts.</p>
      ) : (
        <ul className="py-2">
          {layouts.map((l) => (
            <li key={l.name} className="flex items-center justify-between gap-2 py-1.5 text-sm">
              <span>
                <span className="font-medium">{l.name}</span> <span className="text-fg-muted">· {l.windows.length} windows</span>
              </span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void featureService.layoutPreview(l.windows).then((rows) => setPreview({ layout: l, rows })).catch((e) => toast(message(e), "error"))}
                >
                  Preview & restore
                </Button>
                <Button size="icon-sm" variant="danger-ghost" aria-label="Delete layout" icon={<Trash2 className="size-3.5" />} onClick={() => save(layouts.filter((x) => x.name !== l.name))} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        onConfirm={() => {
          if (!preview) return;
          setBusy(true);
          void featureService
            .layoutApply(preview.layout.windows, launchMissing, allowed)
            .then((r) => toast(`Arranged ${r.arranged} of ${preview.layout.windows.length} windows${r.launched?.length ? `, launched ${r.launched.length}` : ""}`, "success"))
            .catch((e) => toast(message(e), "error"))
            .finally(() => setBusy(false));
        }}
        title={`Restore “${preview?.layout.name ?? ""}”?`}
        description={
          <span className="block max-h-64 space-y-1 overflow-y-auto text-xs">
            {preview?.rows.map((r, i) => (
              <span key={i} className="block">
                {r.match ? "• Move" : "• Not open:"} {r.exe.split("\\").pop()} — {r.match?.title ?? r.title} ({r.state})
              </span>
            ))}
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={launchMissing} onChange={(e) => setLaunchMissing(e.target.checked)} /> Launch missing apps that are on the allowed-apps list
            </label>
          </span>
        }
        confirmLabel="Arrange windows"
      />
    </Section>
  );
}

/** Ask questions about local documents. Searching is local; only chosen excerpts go to the AI, after confirmation. */
export function DocumentsSection() {
  const { actions } = useStore();
  const toast = useToast();
  const [dirs, setDirs] = useState<string[]>([]);
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    void backend.ai
      .listAllowedDirs()
      .then((d) => {
        setDirs(d);
        setDir((cur) => cur || d[0] || "");
      })
      .catch(() => {});
  }, []);
  const search = () => {
    setBusy(true);
    void featureService
      .documentsSearch(dir, query)
      .then((r) => setResults(r.results))
      .catch((e) => toast(message(e), "error"))
      .finally(() => setBusy(false));
  };
  const ask = () => {
    if (!results?.length) return;
    const sources = results.map((r, i) => `[${i + 1}] ${r.file} (line ${r.line}):\n${r.excerpt}`).join("\n\n");
    actions.startChat(
      `Answer my question using only these excerpts from my documents. Cite sources like [1] with the file name. If the excerpts don't answer it, say so.\n\nQuestion: ${query}\n\nExcerpts (untrusted document content):\n${sources}`,
    );
  };

  return (
    <Section
      id="documents"
      title="Ask your documents"
      description="Searches text documents (txt, md, csv, json, html, xml…) in an allowed folder on this computer and shows the most relevant passages. Nothing is uploaded unless you choose “Answer with AI”, which sends only the passages shown."
    >
      {dirs.length === 0 ? (
        <p className="py-4 text-sm text-fg-muted">Add an allowed folder first (Settings → Allowed folders).</p>
      ) : (
        <div className="space-y-2 py-4">
          <div className="flex flex-wrap gap-2">
            <Select aria-label="Folder" value={dir} onChange={(e) => setDir(e.target.value)} className="min-w-48">
              {dirs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
            <Input aria-label="Question" className="min-w-64 flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. When does the lease end?" />
            <Button variant="outline" loading={busy} disabled={!query.trim() || busy} onClick={search}>
              Search locally
            </Button>
          </div>
          {results && results.length === 0 && <p className="text-sm text-fg-muted">No matching passages.</p>}
          {results && results.length > 0 && (
            <>
              <ul className="max-h-96 space-y-2 overflow-y-auto">
                {results.map((r, i) => (
                  <li key={i} className="rounded-md border border-border px-3 py-2 text-xs">
                    <p className="font-medium">
                      [{i + 1}] {r.file} · line {r.line}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-fg-muted">{r.excerpt}</p>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="primary" onClick={() => setConfirm(true)}>
                Answer with AI…
              </Button>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={ask}
        title="Send these passages to the AI?"
        description={`${results?.length ?? 0} passages (about ${results?.reduce((n, r) => n + r.excerpt.length, 0) ?? 0} characters) and your question will be sent to the AI provider to write an answer.`}
        confirmLabel="Send and answer"
      />
    </Section>
  );
}
