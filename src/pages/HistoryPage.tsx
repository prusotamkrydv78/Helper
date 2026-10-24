import { useMemo, useState } from "react";
import { AlertTriangle, History, MessageSquare, MoreHorizontal, Pencil, Pin, Trash2 } from "lucide-react";
import type { Conversation } from "../types";
import { formatDateTime, formatRelative } from "../lib/utils";
import { useStore } from "../store/AppStore";
import { FilterChips, Page, PageHeader, SearchInput } from "../components/layout/Page";
import { TaskStatusIcon } from "../components/task/status";
import { Button } from "../components/ui/Button";
import { ConfirmDialog, Dialog, Menu } from "../components/ui/overlays";
import { EmptyState, Input, Skeleton } from "../components/ui/primitives";

type Filter = "all" | "tasks" | "pinned";

export function HistoryPage() {
  const { state, actions } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const taskOf = (c: Conversation) =>
    c.messages.flatMap((m) => (m.taskId && state.tasks[m.taskId] ? [state.tasks[m.taskId]] : []));

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...state.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((c) => {
        if (filter === "pinned" && !c.pinned) return false;
        if (filter === "tasks" && !c.messages.some((m) => m.taskId)) return false;
        return !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q));
      });
  }, [state.conversations, query, filter]);

  return (
    <Page>
      <PageHeader
        title="History"
        description={
          state.settings.storeHistoryLocally
            ? "All conversations saved on this device."
            : "History storage is off — conversations are kept only until you close the app."
        }
        actions={
          state.conversations.length > 0 && (
            <Button variant="danger-ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmClear(true)}>
              Clear history
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search conversations" className="w-64" />
        <FilterChips
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: state.conversations.length },
            { value: "tasks", label: "With tasks", count: state.conversations.filter((c) => c.messages.some((m) => m.taskId)).length },
            { value: "pinned", label: "Pinned", count: state.conversations.filter((c) => c.pinned).length },
          ]}
        />
      </div>

      {state.loadError ? (
        <EmptyState
          icon={<AlertTriangle className="size-5 text-danger" />}
          title="Couldn't load history"
          description={state.loadError}
          action={<Button onClick={() => window.location.reload()}>Reload</Button>}
        />
      ) : !state.loaded ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : state.conversations.length === 0 ? (
        <EmptyState
          icon={<History className="size-5" />}
          title="No conversations yet"
          description="Your chats will be listed here so you can pick up where you left off."
          action={
            <Button variant="primary" icon={<MessageSquare className="size-4" />} onClick={actions.newChat}>
              Start a chat
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState icon={<History className="size-5" />} title="No matching conversations" description="Try a different search or filter." />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {list.map((c) => {
            const last = c.messages[c.messages.length - 1];
            const tasks = taskOf(c);
            return (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
                <button type="button" onClick={() => actions.selectConversation(c.id)} className="min-w-0 flex-1 cursor-pointer text-left">
                  <div className="flex items-center gap-2">
                    {c.pinned && <Pin className="size-3 shrink-0 text-fg-subtle" />}
                    <span className="truncate text-sm font-medium">{c.title}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">{last ? last.content.replace(/[#*>`_]/g, "").slice(0, 140) : "Empty conversation"}</p>
                  <p className="mt-1 flex items-center gap-2 text-[11px] text-fg-subtle">
                    <span title={formatDateTime(c.updatedAt)}>{formatRelative(c.updatedAt)}</span>·<span>{c.messages.length} messages</span>
                    {tasks.length > 0 && (
                      <>
                        ·
                        <span className="inline-flex items-center gap-1">
                          {tasks.slice(-3).map((t) => (
                            <TaskStatusIcon key={t.id} status={t.status} className="size-3" />
                          ))}
                          {tasks.length} task{tasks.length > 1 ? "s" : ""}
                        </span>
                      </>
                    )}
                  </p>
                </button>
                <Button size="sm" variant="outline" onClick={() => actions.selectConversation(c.id)}>
                  Open
                </Button>
                <Menu
                  items={[
                    { label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(c) },
                    { label: c.pinned ? "Unpin" : "Pin", icon: <Pin />, onSelect: () => actions.togglePin(c.id) },
                    { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(c) },
                  ]}
                  trigger={(p) => (
                    <Button size="icon-sm" variant="ghost" aria-label={`Options for ${c.title}`} icon={<MoreHorizontal className="size-4" />} {...p} />
                  )}
                />
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && actions.deleteConversation(deleting.id)}
        title="Delete conversation?"
        description={deleting ? `“${deleting.title}” and its tasks will be permanently removed.` : undefined}
      />
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={actions.clearAllData}
        title="Clear all history?"
        description="This permanently deletes every conversation and task stored on this device. Settings are kept."
        confirmLabel="Clear history"
      />
      <RenameDialog conv={renaming} onClose={() => setRenaming(null)} />
    </Page>
  );
}

function RenameDialog({ conv, onClose }: { conv: Conversation | null; onClose: () => void }) {
  const { actions } = useStore();
  const [value, setValue] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  if (conv && conv.id !== lastId) {
    setLastId(conv.id);
    setValue(conv.title);
  }
  const submit = () => {
    if (conv && value.trim()) actions.renameConversation(conv.id, value);
    onClose();
  };
  return (
    <Dialog
      open={conv !== null}
      onClose={onClose}
      title="Rename conversation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value.trim()} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} aria-label="Title" />
    </Dialog>
  );
}
