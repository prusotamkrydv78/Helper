import { useState, type ReactNode } from "react";
import {
  Bot,
  BellRing,
  Clipboard,
  FileSearch,
  Sparkles,
  Stethoscope,
  Sunrise,
  LayoutGrid,
  FolderTree,
  Keyboard,
  Mic,
  Brain,
  Database,
  Plug,
  ScrollText,
  Folder,
  FolderPlus,
  Eye,
  KeyRound,
  EyeOff,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Sun,
  Wrench,
} from "lucide-react";
import type { PermissionLevel, Settings } from "../types";
import { useStore } from "../store/AppStore";
import { DEFAULT_PERMISSIONS } from "../store/defaults";
import { ActivityLogSection, BackgroundSection, ClipboardSection, DataSection, FileRulesSection, KnowledgeLibrarySection, SkillsSection, BriefingSection, DiagnosticsSection, GoogleSection, WorkspacesSection, ShortcutsSection, VoiceSection, MemorySection, MicrosoftSection } from "./AssistantSettings";
import { toBackendError } from "../services/tauri/tauriAi";
import { Page, PageHeader } from "../components/layout/Page";
import { Button } from "../components/ui/Button";
import { ConfirmDialog, Tooltip, useToast } from "../components/ui/overlays";
import { Badge, Field, Input, Segmented, Switch, Textarea } from "../components/ui/primitives";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "model", label: "AI model", icon: Bot },
  { id: "folders", label: "Allowed folders", icon: Folder },
  { id: "permissions", label: "Tool permissions", icon: Wrench },
  { id: "microsoft", label: "Accounts", icon: Plug },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "background", label: "Background", icon: BellRing },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "clipboard", label: "Clipboard", icon: Clipboard },
  { id: "rules", label: "File rules", icon: FolderTree },
  { id: "workspaces", label: "Workspaces", icon: LayoutGrid },
  { id: "documents", label: "Knowledge library", icon: FileSearch },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "briefing", label: "Daily briefing", icon: Sunrise },
  { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
  { id: "activity", label: "Activity log", icon: ScrollText },
  { id: "privacy", label: "Privacy & execution", icon: Shield },
  { id: "data", label: "Data", icon: Database },
] as const;

/** Permission rows the backend actually enforces today. */
const ENFORCED_TOOLS = new Set(["fs.read", "fs.write", "browser", "apps", "system", "m365", "google", "input", "clipboard", "fs.delete"]);

function UiOnly({ children = "UI only" }: { children?: ReactNode }) {
  return (
    <Tooltip label="Saved locally, but not yet connected to a backend">
      <Badge tone="warning">{children}</Badge>
    </Tooltip>
  );
}

export function Section({ id, title, description, badge, children }: { id: string; title: string; description?: string; badge?: ReactNode; children: ReactNode }) {
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
  const { state, actions } = useStore();
  const toast = useToast();
  const s = state.settings;
  const set = (patch: Partial<Settings>) => actions.updateSettings(patch);
  const [confirmReset, setConfirmReset] = useState(false);

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

          <MicrosoftSection />

          <GoogleSection />

          <MemorySection />

          <BackgroundSection />

          <ShortcutsSection />

          <VoiceSection />

          <ClipboardSection />

          <FileRulesSection />

          <WorkspacesSection />

          <KnowledgeLibrarySection />

          <SkillsSection />

          <BriefingSection />

          <DiagnosticsSection />

          <ActivityLogSection />

          <DataSection />

          <Section
            id="permissions"
            title="Tool permissions"
            description="Choose what the assistant may do without asking. Enforced by the backend. Sending email, creating events, ending processes and app clicks/typing always ask regardless."
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
            <Field label="Allowed apps" description="Apps the assistant may launch: one full .exe or Start-menu .lnk path per line (the assistant can list installed apps for you). Leave empty to disable launching.">
              {(id) => (
                <Textarea
                  id={id}
                  rows={3}
                  placeholder={"C:\Windows\System32\notepad.exe"}
                  value={s.allowedApps}
                  onChange={(e) => set({ allowedApps: e.target.value })}
                />
              )}
            </Field>
          </Section>


          <Section id="privacy" title="Privacy & execution">
            <Field label="Save conversation history" description="Keep chats and tasks on this device between sessions." inline>
              {() => <Switch checked={s.storeHistoryLocally} onChange={(v) => set({ storeHistoryLocally: v })} label="Save conversation history" />}
            </Field>
            <Field
              label="Require approval for high-risk actions"
              description={
                <span className="inline-flex items-center gap-1.5">
                  High-risk permissions (desktop apps) can't be set to Allow while this is on.
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
              label="Max steps per task"
              description={
                <span className="inline-flex items-center gap-1.5">
                  Most tool-calling rounds per reply (enforced by the backend, max 50).
                </span>
              }
              inline
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={50}
                  value={s.maxStepsPerTask}
                  onChange={(e) => set({ maxStepsPerTask: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
                  className="w-20 text-right"
                />
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
