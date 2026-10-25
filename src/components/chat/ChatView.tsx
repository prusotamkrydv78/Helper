import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  FileSpreadsheet,
  FolderTree,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  Search,
  Trash2,
  Workflow,
} from "lucide-react";
import { useActiveConversation, useStore } from "../../store/AppStore";
import { isTaskActive } from "../../store/reducer";
import { cn } from "../../lib/utils";
import { Button } from "../ui/Button";
import { ConfirmDialog, Menu, Tooltip } from "../ui/overlays";
import { Skeleton } from "../ui/primitives";
import { TaskPanel } from "../task/TaskPanel";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageBubble } from "./MessageBubble";

const SUGGESTIONS = [
  { icon: FolderTree, title: "Organize my Downloads folder", hint: "Sort files into folders by type" },
  { icon: Search, title: "Research a topic and create a report", hint: "Search, read sources, summarize" },
  { icon: FileSpreadsheet, title: "Analyze a spreadsheet", hint: "Statistics, trends and outliers" },
  { icon: Workflow, title: "Help me automate a repetitive workflow", hint: "Turn steps into an automation" },
];

export function ChatView({ composerRef }: { composerRef: React.RefObject<ComposerHandle | null> }) {
  const { state, actions, ai, liveChat } = useStore();
  const conv = useActiveConversation();
  const streaming = conv ? Boolean(state.streaming[conv.id]) : false;

  const tasks = useMemo(
    () =>
      conv
        ? conv.messages.flatMap((m) => (m.taskId && state.tasks[m.taskId] ? [state.tasks[m.taskId]] : []))
        : [],
    [conv, state.tasks],
  );
  const hasActiveTask = tasks.some(isTaskActive);
  const awaiting = tasks.some((t) => t.status === "awaiting_approval");

  // ---- Scrolling ---------------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAtBottom(near);
  };

  // Jump to bottom when switching conversations.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    scrollToBottom(false);
  }, [conv?.id, scrollToBottom]);

  // Follow new content only if the user hasn't scrolled away.
  const lastMsg = conv?.messages[conv.messages.length - 1];
  const contentKey = `${conv?.messages.length}:${lastMsg?.content.length}:${JSON.stringify(tasks.map((t) => t.steps.map((s) => s.status)))}`;
  useEffect(() => {
    if (state.settings.autoScroll && stick.current) scrollToBottom(false);
  }, [contentKey, state.settings.autoScroll, scrollToBottom]);

  // Sending always scrolls down.
  // Keyed on the user-message count: the empty assistant reply is added in the
  // same tick, so the last message is never the user's when this runs.
  const userMsgCount = conv?.messages.filter((m) => m.role === "user").length ?? 0;
  const prevUserCount = useRef(userMsgCount);
  useEffect(() => {
    const sent = userMsgCount > prevUserCount.current;
    prevUserCount.current = userMsgCount;
    if (!sent) return;
    stick.current = true;
    setAtBottom(true);
    requestAnimationFrame(() => scrollToBottom());
  }, [userMsgCount, scrollToBottom]);

  // ---- Header actions ---------------------------------------------------
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const empty = !conv || conv.messages.length === 0;
  const lastAssistantIdx = conv ? conv.messages.map((m) => m.role).lastIndexOf("assistant") : -1;
  const canRegenerate = !streaming && Boolean(conv?.messages.some((m) => m.role === "user"));
  const openSettings = useCallback(() => actions.setView("settings"), [actions]);

  return (
    <div className="relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {conv && renaming ? (
              <input
                autoFocus
                defaultValue={conv.title}
                aria-label="Conversation title"
                onBlur={(e) => {
                  actions.renameConversation(conv.id, e.target.value);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="h-7 w-full max-w-md rounded-md border border-accent bg-surface px-2 text-sm outline-none"
              />
            ) : (
              <h1
                className="truncate text-sm font-medium"
                onDoubleClick={() => conv && setRenaming(true)}
                title={conv ? "Double-click to rename" : undefined}
              >
                {conv?.title ?? "New chat"}
              </h1>
            )}
            {conv?.pinned && <Pin className="size-3.5 shrink-0 text-fg-subtle" />}
          </div>

          {ai && (
            <Tooltip
              label={
                liveChat
                  ? "Chat is connected to OpenAI. File tools work inside folders you allow; automations are still simulated."
                  : ai.available
                    ? "No API key configured — replies come from a mock service. Add a key in Settings."
                    : "Running outside the desktop app — replies come from a mock service."
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={() => actions.setView("settings")}
                className="hidden cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg sm:inline-flex"
              >
                <span className={cn("size-1.5 rounded-full", liveChat ? "bg-success" : "bg-warning")} />
                {liveChat ? "OpenAI connected" : "Demo mode"}
              </button>
            </Tooltip>
          )}

          {conv && (
            <Menu
              items={[
                { label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
                { label: conv.pinned ? "Unpin" : "Pin", icon: <Pin />, onSelect: () => actions.togglePin(conv.id) },
                { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirmDelete(true) },
              ]}
              trigger={(p) => (
                <Button size="icon-sm" variant="ghost" aria-label="Conversation options" icon={<MoreHorizontal className="size-4" />} {...p} />
              )}
            />
          )}
          <Tooltip label={state.ui.panelOpen ? "Hide task details" : "Show task details"} side="bottom">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle task details"
              aria-pressed={state.ui.panelOpen}
              className={cn("relative", state.ui.panelOpen && "bg-surface-2 text-fg")}
              icon={<PanelRight className="size-4" />}
              onClick={() => actions.togglePanel()}
            >
              {hasActiveTask && !state.ui.panelOpen && (
                <span className={cn("absolute right-1 top-1 size-1.5 rounded-full", awaiting ? "bg-warning" : "bg-info")} />
              )}
            </Button>
          </Tooltip>
        </header>

        {!state.loaded ? (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-10">
            <Skeleton className="ml-auto h-10 w-2/5" />
            <Skeleton className="h-24 w-4/5" />
            <Skeleton className="ml-auto h-10 w-1/3" />
          </div>
        ) : empty ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-10">
            <div className="w-full max-w-2xl animate-fade-in">
              <div className="mb-8 text-center">
                <h2 className="text-[1.7rem] font-semibold tracking-tight">What would you like to automate?</h2>
                <p className="mt-2 text-sm text-fg-muted">
                  Describe a task in plain language. You'll see every step, and nothing changes without your approval.
                </p>
              </div>
              <Composer ref={composerRef} streaming={streaming} onStop={() => conv && actions.stopGeneration(conv.id)} large />
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map(({ icon: Icon, title, hint }) => (
                  <button
                    key={title}
                    type="button"
                    onClick={() => actions.sendMessage(title)}
                    className="group flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-transparent px-3.5 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface"
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-colors group-hover:text-accent" />
                    <span>
                      <span className="block text-sm text-fg">{title}</span>
                      <span className="block text-xs text-fg-subtle">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              {state.loadError && (
                <p className="mt-6 text-center text-xs text-danger">Couldn't load history: {state.loadError}</p>
              )}
            </div>
          </div>
        ) : (
          <>
            <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-6 pb-8 pt-6">
                {conv.messages.map((m, i) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    task={m.taskId ? state.tasks[m.taskId] : undefined}
                    isLast={i === lastAssistantIdx && i === conv.messages.length - 1}
                    compact={state.settings.compactMessages}
                    onRegenerate={m.role === "assistant" && canRegenerate ? () => actions.regenerate(conv.id) : undefined}
                    onOpenSettings={openSettings}
                  />
                ))}
              </div>
            </div>
            <div className="relative shrink-0 px-6 pb-5">
              {!atBottom && (
                <button
                  type="button"
                  onClick={() => scrollToBottom()}
                  aria-label="Jump to latest message"
                  className="absolute -top-12 left-1/2 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-fg-muted shadow-pop transition-colors hover:text-fg animate-pop"
                >
                  <ArrowDown className="size-4" />
                </button>
              )}
              <div className="mx-auto max-w-3xl">
                <Composer ref={composerRef} streaming={streaming} onStop={() => actions.stopGeneration(conv.id)} />
                <p className="mt-2 text-center text-[11px] text-fg-subtle">
                  {!liveChat
                    ? "Demo mode — responses and task results are simulated. Nothing runs on your PC."
                    : "AI responses can be wrong. File tools only reach folders you allow, and changes need your approval."}
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {state.ui.panelOpen && <TaskPanel conversationTasks={tasks} />}

      {conv && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => actions.deleteConversation(conv.id)}
          title="Delete conversation?"
          description={`“${conv.title}” and its tasks will be permanently removed.`}
        />
      )}
    </div>
  );
}
