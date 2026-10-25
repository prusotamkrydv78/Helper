import { useState, type ReactNode } from "react";
import {
  Bot,
  Cpu,
  Folder,
  FolderPlus,
  Eye,
  KeyRound,
  EyeOff,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Sun,
  Wrench,
} from "lucide-react";
import type { PermissionLevel, Settings } from "../types";
import { cn, formatRelative } from "../lib/utils";
import { useStore } from "../store/AppStore";
import { DEFAULT_PERMISSIONS } from "../store/defaults";
import { toBackendError } from "../services/tauri/tauriAi";
import { Page, PageHeader } from "../components/layout/Page";
import { Button, Spinner } from "../components/ui/Button";
import { ConfirmDialog, Tooltip, useToast } from "../components/ui/overlays";
import { Badge, Field, Input, Segmented, Switch, Textarea } from "../components/ui/primitives";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "model", label: "AI model", icon: Bot },
  { id: "folders", label: "Allowed folders", icon: Folder },
  { id: "permissions", label: "Tool permissions", icon: Wrench },
  { id: "agent", label: "Local agent", icon: Cpu },
  { id: "privacy", label: "Privacy & execution", icon: Shield },
] as const;

/** Permission rows the backend actually enforces today. */
const ENFORCED_TOOLS = new Set(["fs.read", "fs.write", "browser"]);

function UiOnly({ children = "UI only" }: { children?: ReactNode }) {
  return (
    <Tooltip label="Saved locally, but not yet connected to a backend">
      <Badge tone="warning">{children}</Badge>
    </Tooltip>
  );
}

function Section({ id, title, description, badge, children }: { id: string; title: string; description?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {badge}
      </div>
      {description && <p className="-mt-1 mb-3 text-sm text-fg-muted">{description}</p>}
      <div className="divide-y divide-border rounded-xl border border-border bg-surface px-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const { state, actions, agent } = useStore();
  const toast = useToast();
  const s = state.settings;
  const set = (patch: Partial<Settings>) => actions.updateSettings(patch);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const jump = (id: string) =>
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: s.reduceMotion ? "auto" : "smooth", block: "start" });

  return (
    <Page className="max-w-5xl">
      <PageHeader
        title="Settings"
        description="Preferences are saved on this device."
        actions={
          <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setConfirmReset(true)}>
            Reset to defaults
          </Button>
        }
      />

      <div className="flex gap-10">
        <nav aria-label="Settings sections" className="sticky top-0 hidden w-44 shrink-0 self-start md:block">
          <ul className="space-y-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => jump(id)}
                  className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 space-y-9">
          <Section id="general" title="General">
            <Field label="Send with Enter" description="When off, use Ctrl+Enter to send and Enter for a new line." inline>
              {() => <Switch checked={s.sendOnEnter} onChange={(v) => set({ sendOnEnter: v })} label="Send with Enter" />}
            </Field>
            <Field label="Auto-scroll" description="Follow new messages while you're at the bottom of a chat." inline>
              {() => <Switch checked={s.autoScroll} onChange={(v) => set({ autoScroll: v })} label="Auto-scroll" />}
            </Field>
            <Field label="Open task details automatically" description="Show the side panel when a task starts." inline>
              {() => (
                <Switch
                  checked={s.showTaskPanelAutomatically}
                  onChange={(v) => set({ showTaskPanelAutomatically: v })}
                  label="Open task details automatically"
                />
              )}
            </Field>
          </Section>

          <Section id="appearance" title="Appearance">
            <Field label="Theme" inline>
              {() => (
                <Segmented
                  label="Theme"
                  value={s.theme}
                  onChange={(theme) => set({ theme })}
                  options={[
                    { value: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
                    { value: "light", label: "Light", icon: <Sun className="size-3.5" /> },
                    { value: "system", label: "System", icon: <Monitor className="size-3.5" /> },
                  ]}
                />
              )}
            </Field>
            <Field label="Text size" inline>
              {() => (
                <Segmented
                  label="Text size"
                  value={s.fontSize}
                  onChange={(fontSize) => set({ fontSize })}
                  options={[
                    { value: "sm", label: "Small" },
                    { value: "md", label: "Default" },
                    { value: "lg", label: "Large" },
                  ]}
                />
              )}
            </Field>
            <Field label="Compact messages" description="Reduce spacing between messages." inline>
              {() => <Switch checked={s.compactMessages} onChange={(v) => set({ compactMessages: v })} label="Compact messages" />}
            </Field>
            <Field label="Reduce motion" description="Minimize animations and transitions." inline>
              {() => <Switch checked={s.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" />}
            </Field>
          </Section>

          <AiModelSection />

          <AllowedFoldersSection />

          <Section
            id="permissions"
            title="Tool permissions"
            description="Choose what the assistant may do without asking. File and browser permissions are enforced by the backend; terminal and desktop-app tools aren't built."
          >
            {s.permissions.map((p) => (
              <Field
                key={p.tool}
                inline
                label={p.label}
                description={
                  <span className="inline-flex items-center gap-1.5">
                    {DEFAULT_PERMISSIONS.find((d) => d.tool === p.tool)?.description ?? p.description}
                    {p.risk === "high" && <Badge tone="danger">High risk</Badge>}
                    {!ENFORCED_TOOLS.has(p.tool) && <UiOnly>Not built yet</UiOnly>}
                  </span>
                }
              >
                {() => (
                  <Segmented<PermissionLevel>
                    label={`${p.label} permission`}
                    value={p.level}
                    onChange={(level) => {
                      if (level === "allow" && p.risk === "high" && s.requireApprovalForHighRisk) {
                        toast("High-risk tools always ask while “Require approval for high-risk actions” is on", "info");
                        return;
                      }
                      set({ permissions: s.permissions.map((x) => (x.tool === p.tool ? { ...x, level } : x)) });
                    }}
                    options={[
                      { value: "allow", label: "Allow" },
                      { value: "ask", label: "Ask" },
                      { value: "deny", label: "Deny" },
                    ]}
                  />
                )}
              </Field>
            ))}
          </Section>

          <Section id="agent" title="Local PC agent" description="The local executor carries out approved actions on this computer.">
            <div className="flex flex-wrap items-center gap-4 py-4">
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border",
                  agent.state === "connected" ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface-2 text-fg-subtle",
                )}
              >
                {agent.state === "checking" ? <Spinner className="size-4" /> : <Cpu className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {agent.state === "checking" && "Checking connection…"}
                  {agent.state === "connected" && "Connected"}
                  {agent.state === "disconnected" && "Disconnected"}
                  {agent.state === "not_installed" && "Not installed"}
                  {agent.state !== "checking" && (
                    <span
                      className={cn("size-1.5 rounded-full", agent.state === "connected" ? "bg-success" : "bg-fg-subtle")}
                      aria-hidden
                    />
                  )}
                </p>
                <p className="text-xs text-fg-muted">
                  {agent.state === "connected" && `Version ${agent.version}`}
                  {(agent.state === "not_installed" || agent.state === "disconnected") && agent.detail}
                  {agent.state === "checking" && "Looking for a local executor…"}
                </p>
                {"checkedAt" in agent && <p className="mt-0.5 text-[11px] text-fg-subtle">Checked {formatRelative(agent.checkedAt)}</p>}
              </div>
              <Button variant="outline" icon={<RefreshCw className="size-3.5" />} loading={agent.state === "checking"} onClick={actions.checkAgent}>
                Check again
              </Button>
            </div>
          </Section>

          <Section id="privacy" title="Privacy & execution">
            <Field label="Save conversation history" description="Keep chats and tasks on this device between sessions." inline>
              {() => <Switch checked={s.storeHistoryLocally} onChange={(v) => set({ storeHistoryLocally: v })} label="Save conversation history" />}
            </Field>
            <Field
              label="Require approval for high-risk actions"
              description={
                <span className="inline-flex items-center gap-1.5">
                  Deleting files, running commands and controlling apps always ask first. <UiOnly />
                </span>
              }
              inline
            >
              {() => (
                <Switch
                  checked={s.requireApprovalForHighRisk}
                  onChange={(v) => {
                    set({
                      requireApprovalForHighRisk: v,
                      permissions: v
                        ? s.permissions.map((p) => (p.risk === "high" && p.level === "allow" ? { ...p, level: "ask" } : p))
                        : s.permissions,
                    });
                  }}
                  label="Require approval for high-risk actions"
                />
              )}
            </Field>
            <Field
              label="Sandbox mode"
              description={
                <span className="inline-flex items-center gap-1.5">
                  Restrict file access to approved folders. <UiOnly />
                </span>
              }
              inline
            >
              {() => <Switch checked={s.sandboxMode} onChange={(v) => set({ sandboxMode: v })} label="Sandbox mode" />}
            </Field>
            <Field
              label="Max steps per task"
              description={
                <span className="inline-flex items-center gap-1.5">
                  Stop a task after this many tool calls. <UiOnly />
                </span>
              }
              inline
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={100}
                  value={s.maxStepsPerTask}
                  onChange={(e) => set({ maxStepsPerTask: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
                  className="w-20 text-right"
                />
              )}
            </Field>
            <Field label="Clear conversation history" description="Delete all chats and tasks stored on this device." inline>
              {() => (
                <Button variant="danger-ghost" onClick={() => setConfirmClear(true)}>
                  Clear…
                </Button>
              )}
            </Field>
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          actions.resetSettings();
          toast("Settings reset to defaults", "success");
        }}
        title="Reset settings?"
        description="All preferences return to their defaults. Conversations and automations are kept."
        confirmLabel="Reset"
      />
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          actions.clearAllData();
          toast("Conversation history cleared", "success");
        }}
        title="Clear conversation history?"
        description="This permanently deletes every conversation and task on this device."
        confirmLabel="Clear history"
      />
    </Page>
  );
}

function AiModelSection() {
  const { state, actions, ai, liveChat } = useStore();
  const toast = useToast();
  const s = state.settings;
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function saveKey() {
    setSaving(true);
    setError(null);
    try {
      await actions.saveApiKey(keyInput);
      setKeyInput(""); // never keep the key in UI state once stored
      setShowKey(false);
      toast("API key saved to the system credential store", "success");
    } catch (e) {
      setError(toBackendError(e).message);
    } finally {
      setSaving(false);
    }
  }

  async function removeKey() {
    try {
      await actions.removeApiKey();
      toast("API key removed", "success");
    } catch (e) {
      toast(toBackendError(e).message, "error");
    }
  }

  const statusBadge = !ai ? (
    <Badge tone="neutral">Checking…</Badge>
  ) : !ai.available ? (
    <Badge tone="warning">Desktop app only</Badge>
  ) : liveChat ? (
    <Badge tone="success">Connected</Badge>
  ) : (
    <Badge tone="warning">Not configured</Badge>
  );

  return (
    <Section
      id="model"
      title="AI model"
      badge={statusBadge}
      description="Chat is sent to OpenAI through the app's Rust backend. Without a key, replies come from the built-in mock."
    >
      <Field
        label="API key"
        description={
          ai?.source === "environment"
            ? "Using OPENAI_API_KEY from the environment. Unset it to manage the key here."
            : "Stored in the system credential store (Windows Credential Manager). It never leaves the backend."
        }
      >
        {(id) =>
          !ai?.available ? (
            <p className="text-sm text-fg-muted">Open the desktop app (npm run tauri dev) to configure a key.</p>
          ) : ai.configured ? (
            <div className="flex items-center gap-3">
              <span className="flex h-8.5 flex-1 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm text-fg-muted">
                <KeyRound className="size-3.5" />
                sk-•••• {ai.keyHint}
                <span className="ml-auto font-sans text-xs text-fg-subtle">
                  {ai.source === "environment" ? "environment" : "credential store"}
                </span>
              </span>
              {ai.source === "keychain" && (
                <Button variant="danger-ghost" onClick={() => setConfirmRemove(true)}>
                  Remove
                </Button>
              )}
            </div>
          ) : (
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (keyInput.trim()) void saveKey();
              }}
            >
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id={id}
                    type={showKey ? "text" : "password"}
                    value={keyInput}
                    onChange={(e) => {
                      setKeyInput(e.target.value);
                      setError(null);
                    }}
                    placeholder="sk-…"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={error !== null}
                    className="pr-9 font-mono"
                  />
                  <button
                    type="button"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-fg-subtle hover:text-fg"
                  >
                    {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                <Button type="submit" variant="primary" loading={saving} disabled={!keyInput.trim()}>
                  Save key
                </Button>
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
            </form>
          )
        }
      </Field>
      <Field
        label="Model"
        description="Leave empty to use the backend default (OPENAI_MODEL, or gpt-4o-mini). Any model your account can use with Chat Completions works."
      >
        {(id) => (
          <Input
            id={id}
            value={s.model}
            onChange={(e) => actions.updateSettings({ model: e.target.value })}
            placeholder="Default"
            spellCheck={false}
            className="font-mono"
          />
        )}
      </Field>
      <Field label="System instructions">
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            value={s.systemPrompt}
            onChange={(e) => actions.updateSettings({ systemPrompt: e.target.value })}
          />
        )}
      </Field>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void removeKey()}
        title="Remove API key?"
        description="Chat will switch back to demo mode until you add a key again."
        confirmLabel="Remove"
      />
    </Section>
  );
}

function AllowedFoldersSection() {
  const { actions, ai, allowedDirs } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    try {
      if (await actions.addAllowedDir()) toast("Folder added", "success");
    } catch (e) {
      toast(toBackendError(e).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="folders"
      title="Allowed folders"
      description="The assistant's file tools can only see and change files inside these folders. Nothing outside them is reachable."
    >
      <div className="space-y-2 py-4">
        {!ai?.available ? (
          <p className="text-sm text-fg-muted">Available in the desktop app.</p>
        ) : allowedDirs.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No folders yet — file tools are turned off until you add one. Start with a dedicated folder rather than your
            whole Documents folder.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {allowedDirs.map((d) => (
              <li key={d} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2">
                <Folder className="size-4 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={d}>
                  {d}
                </span>
                <Button size="sm" variant="danger-ghost" onClick={() => setRemoving(d)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {ai?.available && (
          <Button variant="outline" icon={<FolderPlus className="size-4" />} loading={busy} onClick={() => void add()}>
            Add folder…
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) actions.removeAllowedDir(removing).catch((e) => toast(toBackendError(e).message, "error"));
        }}
        title="Remove folder?"
        description={removing ? `The assistant will no longer be able to access ${removing}. Files are not deleted.` : undefined}
        confirmLabel="Remove"
      />
    </Section>
  );
}
