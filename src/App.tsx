import { useEffect, useRef } from "react";
import { AppStoreProvider, useStore } from "./store/AppStore";
import { ToastProvider } from "./components/ui/overlays";
import { Sidebar } from "./components/layout/Sidebar";
import { ChatView } from "./components/chat/ChatView";
import type { ComposerHandle } from "./components/chat/Composer";
import { TasksPage } from "./pages/TasksPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { CommandCenterPage } from "./pages/CommandCenterPage";
import { assistantService, featureService } from "./services/tauri/assistant";
import { isTauri } from "./services/tauri/tauriAi";
import { listen } from "@tauri-apps/api/event";
import { useWorkflows } from "./store/WorkflowStore";
import { useToast } from "./components/ui/overlays";
import { WorkflowProvider } from "./store/WorkflowStore";
import { NotificationProvider } from "./store/NotificationStore";
import { NotificationsPage } from "./pages/NotificationsPage";
import { RunningPage } from "./pages/RunningPage";
import { VoiceController } from "./components/voice/VoiceController";
import { ScheduleProvider } from "./store/ScheduleStore";
import { AutomationsPage } from "./pages/AutomationsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";

function useAppearance() {
  const { state } = useStore();
  const { theme, fontSize, reduceMotion } = state.settings;
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      root.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    root.dataset.fontSize = fontSize;
    root.toggleAttribute("data-reduce-motion", reduceMotion);
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, fontSize, reduceMotion]);
}

function Shell() {
  const { state, actions } = useStore();
  const composerRef = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useAppearance();
  const { activeId, actions: wf } = useWorkflows();
  const toast = useToast();
  // Global shortcuts and clipboard history are applied in the backend.
  useEffect(() => {
    const s = state.settings;
    void featureService
      .setShortcuts(s.globalShortcuts ? s.shortcuts : {})
      .then((failed) => failed.length && toast(`Some shortcuts couldn't be registered: ${failed.join("; ")}`, "error"))
      .catch(() => {});
  }, [state.settings.globalShortcuts, state.settings.shortcuts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void featureService.clipSetEnabled(state.settings.clipboardHistory).catch(() => {}), [state.settings.clipboardHistory]);
  useEffect(() => void featureService.browserSetPersistent(state.settings.browserPersistent).catch(() => {}), [state.settings.browserPersistent]);
  const shortcutRef = useRef<(a: string) => void>(() => {});
  shortcutRef.current = (action: string) => {
    if (action === "summon") {
      actions.setView("chat");
      requestAnimationFrame(() => composerRef.current?.focus());
    } else if (action === "voice") {
      actions.setView("chat");
      requestAnimationFrame(() => window.dispatchEvent(new Event("jarvis:voice")));
    } else if (action === "pause") {
      if (activeId) wf.pause(activeId);
      toast(activeId ? "The workflow pauses after its current step" : "No workflow is running", "info");
    } else if (action === "stop") {
      actions.stopAll();
      toast("Stopped running tasks", "info");
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    void listen<string>("shortcut", (e) => shortcutRef.current(e.payload)).then((u) => (off = u));
    return () => off?.();
  }, []);
  // The backend decides on window close whether to hide to the tray.
  useEffect(() => assistantService.setKeepInTray(state.settings.keepInTray), [state.settings.keepInTray]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        actions.newChat();
        requestAnimationFrame(() => composerRef.current?.focus());
      } else if (key === "k") {
        e.preventDefault();
        if (state.ui.sidebarCollapsed) actions.toggleSidebar();
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (key === "b") {
        e.preventDefault();
        actions.toggleSidebar();
      } else if (key === "j") {
        e.preventDefault();
        actions.togglePanel();
      } else if (key === ",") {
        e.preventDefault();
        actions.setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, state.ui.sidebarCollapsed]);

  // Escape stops the response being generated in the open chat.
  useEffect(() => {
    const id = state.ui.activeConversationId;
    if (!id || !state.streaming[id]) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog],[role=menu]")) actions.stopGeneration(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, state.ui.activeConversationId, state.streaming]);

  return (
    <div className="flex h-full bg-bg text-fg">
      <Sidebar searchRef={searchRef} />
      <main className="relative min-w-0 flex-1">
        {state.ui.view === "home" && <CommandCenterPage />}
        {state.ui.view === "notifications" && <NotificationsPage />}
        {state.ui.view === "running" && <RunningPage />}
        {state.ui.view === "chat" && <ChatView composerRef={composerRef} />}
        {state.ui.view === "tasks" && <TasksPage />}
        {state.ui.view === "workflows" && <WorkflowsPage />}
        {state.ui.view === "automations" && <AutomationsPage />}
        {state.ui.view === "history" && <HistoryPage />}
        {state.ui.view === "settings" && <SettingsPage />}
        <VoiceController />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppStoreProvider>
      <NotificationProvider>
        <WorkflowProvider>
          <ScheduleProvider>
            <ToastProvider>
              <Shell />
            </ToastProvider>
          </ScheduleProvider>
        </WorkflowProvider>
      </NotificationProvider>
    </AppStoreProvider>
  );
}
