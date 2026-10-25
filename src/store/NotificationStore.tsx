import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ID, View } from "../types";
import { load, save } from "../lib/storage";
import { nowISO, uid } from "../lib/utils";
import { notifyIfAway } from "../services/tauri/assistant";
import { useStore } from "./AppStore";

/**
 * In-app notification center: approvals, finished/failed/interrupted workflows,
 * reminders and fired triggers. Kept on this device (titles and short text only),
 * capped at 200 entries. New entries also raise a Windows notification while the
 * app isn't in focus (if notifications are on).
 */

export type NotificationKind = "approval" | "completed" | "failed" | "reminder" | "trigger" | "interrupted";

export interface AppNotification {
  id: ID;
  kind: NotificationKind;
  title: string;
  body: string;
  at: string;
  read: boolean;
  /** Where "Review" goes. */
  target?: { view: View; conversationId?: ID };
  /** De-duplication key (e.g. one notification per pending approval). */
  key?: string;
}

interface NotificationValue {
  items: AppNotification[];
  unread: number;
  push(n: Omit<AppNotification, "id" | "at" | "read">): void;
  markRead(id: ID): void;
  markAllRead(): void;
  dismiss(id: ID): void;
  clear(): void;
}

const Ctx = createContext<NotificationValue | null>(null);
const MAX = 200;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const [items, setItems] = useState<AppNotification[]>(() => load<AppNotification[]>("notifications", []));
  const notifyRef = useRef(state.settings.notifications);
  notifyRef.current = state.settings.notifications;

  useEffect(() => save("notifications", items), [items]);

  const push = useCallback((n: Omit<AppNotification, "id" | "at" | "read">) => {
    setItems((list) => {
      if (n.key && list.some((x) => x.key === n.key)) return list;
      return [{ ...n, id: uid("ntf"), at: nowISO(), read: false }, ...list].slice(0, MAX);
    });
    notifyIfAway(notifyRef.current, n.title, n.body);
  }, []);

  // Approvals waiting anywhere (chats and workflow runs) become notifications.
  useEffect(() => {
    for (const t of Object.values(state.tasks)) {
      for (const s of t.steps) {
        if (s.status === "awaiting_approval")
          push({
            kind: "approval",
            title: "Approval needed",
            body: s.approvalReason || s.title,
            key: `approval:${t.id}:${s.id}`,
            target: { view: "chat", conversationId: t.conversationId },
          });
      }
    }
  }, [state.tasks, push]);

  const value = useMemo<NotificationValue>(
    () => ({
      items,
      unread: items.filter((n) => !n.read).length,
      push,
      markRead: (id) => setItems((l) => l.map((n) => (n.id === id ? { ...n, read: true } : n))),
      markAllRead: () => setItems((l) => l.map((n) => ({ ...n, read: true }))),
      dismiss: (id) => setItems((l) => l.filter((n) => n.id !== id)),
      clear: () => setItems([]),
    }),
    [items, push],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications must be used inside NotificationProvider");
  return v;
}
