import { AlarmClock, AlertTriangle, Bell, CheckCircle2, ShieldAlert, XCircle, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Page, PageHeader } from "../components/layout/Page";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/primitives";
import { useStore } from "../store/AppStore";
import { useNotifications, type AppNotification, type NotificationKind } from "../store/NotificationStore";
import { cn, formatRelative } from "../lib/utils";

const ICON: Record<NotificationKind, ReactNode> = {
  approval: <ShieldAlert className="size-4 text-warning" />,
  completed: <CheckCircle2 className="size-4 text-success" />,
  failed: <XCircle className="size-4 text-danger" />,
  reminder: <AlarmClock className="size-4 text-info" />,
  trigger: <Zap className="size-4 text-info" />,
  interrupted: <AlertTriangle className="size-4 text-warning" />,
};

export function NotificationsPage() {
  const { items, markRead, markAllRead, dismiss, clear } = useNotifications();
  const { actions } = useStore();
  const review = (n: AppNotification) => {
    markRead(n.id);
    if (!n.target) return;
    if (n.target.conversationId) actions.selectConversation(n.target.conversationId);
    else actions.setView(n.target.view);
  };
  return (
    <Page>
      <PageHeader
        title="Notifications"
        description="Approvals, finished and failed tasks, reminders, triggers and interrupted workflows. Kept on this device."
        actions={
          items.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={markAllRead}>
                Mark all read
              </Button>
              <Button size="sm" variant="danger-ghost" onClick={clear}>
                Clear all
              </Button>
            </>
          )
        }
      />
      {items.length === 0 ? (
        <EmptyState icon={<Bell className="size-5" />} title="No notifications" description="You're all caught up." />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id} className={cn("flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3", !n.read && "border-accent/40")}>
              <span className="mt-0.5">{ICON[n.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm", !n.read && "font-medium")}>{n.title}</p>
                <p className="whitespace-pre-wrap text-sm text-fg-muted">{n.body}</p>
                <p className="mt-0.5 text-xs text-fg-subtle">{formatRelative(n.at)}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {n.target && (
                  <Button size="sm" variant="outline" onClick={() => review(n)}>
                    Review
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => dismiss(n.id)}>
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
