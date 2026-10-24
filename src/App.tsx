import { useEffect, useRef } from "react";
import { AppStoreProvider, useStore } from "./store/AppStore";
import { ToastProvider } from "./components/ui/overlays";
import { Sidebar } from "./components/layout/Sidebar";
import { ChatView } from "./components/chat/ChatView";
import type { ComposerHandle } from "./components/chat/Composer";
import { TasksPage } from "./pages/TasksPage";
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
        {state.ui.view === "chat" && <ChatView composerRef={composerRef} />}
        {state.ui.view === "tasks" && <TasksPage />}
        {state.ui.view === "automations" && <AutomationsPage />}
        {state.ui.view === "history" && <HistoryPage />}
        {state.ui.view === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppStoreProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AppStoreProvider>
  );
}
