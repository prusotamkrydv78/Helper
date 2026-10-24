import { useMemo, useState } from "react";
import {
  History,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { Conversation, View } from "../../types";
import { cn, dateBucket } from "../../lib/utils";
import { useStore } from "../../store/AppStore";
import { isTaskActive } from "../../store/reducer";
import { Button } from "../ui/Button";
import { ConfirmDialog, Menu, Tooltip } from "../ui/overlays";
import { Kbd, Skeleton } from "../ui/primitives";

const NAV: { view: View; label: string; icon: typeof MessageSquare }[] = [
  { view: "chat", label: "Chats", icon: MessageSquare },
  { view: "tasks", label: "Tasks", icon: ListChecks },
  { view: "automations", label: "Automations", icon: Workflow },
  { view: "history", label: "History", icon: History },
];

export function Sidebar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }) {
  const { state, actions } = useStore();
  const collapsed = state.ui.sidebarCollapsed;
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  const activeTasks = Object.values(state.tasks).filter(isTaskActive);
  const awaitingCount = activeTasks.filter((t) => t.status === "awaiting_approval").length;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = state.conversations
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const out = new Map<string, Conversation[]>();
    for (const c of list) {
      const key = c.pinned ? "Pinned" : dateBucket(c.updatedAt);
      out.set(key, [...(out.get(key) ?? []), c]);
    }
    const order = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
    return order.filter((k) => out.has(k)).map((k) => [k, out.get(k)!] as const);
  }, [state.conversations, query]);

  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-bg-subtle transition-[width] duration-200 ease-out",
        collapsed ? "w-[60px]" : "w-[268px]",
      )}
    >
      {/* Brand */}
      <div className={cn("flex h-12 shrink-0 items-center", collapsed ? "justify-center" : "justify-between pl-4 pr-2")}>
        {!collapsed && (
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-sm font-semibold tracking-tight">AI Automation</span>
          </div>
        )}
        <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} side={collapsed ? "right" : "bottom"}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            icon={collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            onClick={actions.toggleSidebar}
          />
        </Tooltip>
      </div>

      {/* New chat */}
      <div className={cn("px-2.5 pb-2", collapsed && "flex justify-center")}>
        {collapsed ? (
          <Tooltip label="New chat" side="right">
            <Button size="icon" variant="outline" aria-label="New chat" icon={<Plus className="size-4" />} onClick={actions.newChat} />
          </Tooltip>
        ) : (
          <Button variant="outline" className="w-full justify-start" icon={<Plus className="size-4" />} onClick={actions.newChat}>
            New chat
            <span className="ml-auto flex gap-0.5">
              <Kbd>Ctrl</Kbd>
              <Kbd>N</Kbd>
            </span>
          </Button>
        )}
      </div>

      {/* Navigation */}
      <nav className="space-y-0.5 px-2.5 pb-2">
        {NAV.map(({ view, label, icon: Icon }) => {
          const active = state.ui.view === view;
          const badge =
            view === "tasks" && activeTasks.length > 0 ? (
              <span
                className={cn(
                  "ml-auto rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                  awaitingCount ? "bg-warning-soft text-warning" : "bg-info-soft text-info",
                )}
              >
                {activeTasks.length}
              </span>
            ) : null;
          const item = (
            <button
              key={view}
              type="button"
              onClick={() => actions.setView(view)}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              className={cn(
                "relative flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg text-sm transition-colors",
                collapsed ? "justify-center" : "px-2.5",
                active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && label}
              {!collapsed && badge}
              {collapsed && badge && (
                <span className={cn("absolute right-2 top-1.5 size-1.5 rounded-full", awaitingCount ? "bg-warning" : "bg-info")} />
              )}
            </button>
          );
          return collapsed ? (
            <Tooltip key={view} label={label} side="right">
              {item}
            </Tooltip>
          ) : (
            item
          );
        })}
      </nav>

      {/* Conversations */}
      {!collapsed ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border pt-2.5">
          <div className="relative px-2.5 pb-2">
            <Search className="pointer-events-none absolute left-5 top-1/2 size-3.5 -translate-y-[calc(50%+4px)] text-fg-subtle" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search chats"
              aria-label="Search conversations"
              className="h-8 w-full rounded-lg border border-transparent bg-surface-2 pl-7.5 pr-7 text-sm outline-none placeholder:text-fg-subtle focus:border-border-strong"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-4.5 top-1/2 -translate-y-[calc(50%+4px)] cursor-pointer rounded p-0.5 text-fg-subtle hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-2.5 pb-3">
            {!state.loaded ? (
              <div className="space-y-2 px-1 pt-2">
                {[70, 55, 80, 60].map((w) => (
                  <Skeleton key={w} className="h-4" />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-fg-subtle">
                {query ? "No chats match your search." : "Your conversations will appear here."}
              </p>
            ) : (
              groups.map(([label, convs]) => (
                <div key={label} className="mb-3">
                  <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-fg-subtle">{label}</p>
                  <ul className="space-y-px">
                    {convs.map((c) => (
                      <ConversationRow
                        key={c.id}
                        conv={c}
                        active={state.ui.view === "chat" && c.id === state.ui.activeConversationId}
                        running={Boolean(state.streaming[c.id]) || Object.values(state.tasks).some((t) => t.conversationId === c.id && isTaskActive(t))}
                        onDelete={() => setDeleting(c)}
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* Footer */}
      <div className={cn("shrink-0 border-t border-border p-2.5", collapsed && "flex flex-col items-center gap-1")}>
        {collapsed ? (
          <>
            <Tooltip label="Settings" side="right">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Settings"
                className={cn(state.ui.view === "settings" && "bg-surface-3 text-fg")}
                icon={<Settings className="size-4" />}
                onClick={() => actions.setView("settings")}
              />
            </Tooltip>
            <Avatar />
          </>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1">
              <Avatar />
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-medium">Local user</p>
                <p className="truncate text-[11px] text-fg-subtle">Not signed in</p>
              </div>
            </div>
            <Tooltip label="Settings">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Settings"
                className={cn(state.ui.view === "settings" && "bg-surface-3 text-fg")}
                icon={<Settings className="size-4" />}
                onClick={() => actions.setView("settings")}
              />
            </Tooltip>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && actions.deleteConversation(deleting.id)}
        title="Delete conversation?"
        description={deleting ? `“${deleting.title}” and its tasks will be permanently removed.` : undefined}
      />
    </aside>
  );
}

function ConversationRow({
  conv,
  active,
  running,
  onDelete,
}: {
  conv: Conversation;
  active: boolean;
  running: boolean;
  onDelete: () => void;
}) {
  const { actions } = useStore();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          defaultValue={conv.title}
          aria-label="Rename conversation"
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            actions.renameConversation(conv.id, e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-8 w-full rounded-lg border border-accent bg-surface px-2.5 text-sm outline-none"
        />
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => actions.selectConversation(conv.id)}
        onDoubleClick={() => setEditing(true)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-8 text-left text-sm transition-colors",
          active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        )}
      >
        {running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" aria-label="Running" />}
        <span className="truncate">{conv.title}</span>
      </button>
      <div
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
          active && "opacity-100",
        )}
      >
        <Menu
          items={[
            { label: "Rename", icon: <Pencil />, onSelect: () => setEditing(true) },
            {
              label: conv.pinned ? "Unpin" : "Pin",
              icon: conv.pinned ? <PinOff /> : <Pin />,
              onSelect: () => actions.togglePin(conv.id),
            },
            { label: "Delete", icon: <Trash2 />, danger: true, onSelect: onDelete },
          ]}
          trigger={(p) => (
            <button
              type="button"
              aria-label={`Options for ${conv.title}`}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
              {...p}
            >
              <MoreHorizontal className="size-4" />
            </button>
          )}
        />
      </div>
    </li>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-6 items-center justify-center rounded-md bg-accent text-accent-fg", className)}>
      <Zap className="size-3.5 fill-current" />
    </span>
  );
}

function Avatar() {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-3 text-[11px] font-semibold text-fg-muted"
    >
      LU
    </span>
  );
}
