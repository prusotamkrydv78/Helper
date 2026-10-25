//! Tool registry and dispatcher. Only tools listed in `TOOLS` can run; each maps
//! to a Rust function with typed, strictly validated arguments.

pub mod allowed_dirs;
pub mod fs;
pub mod fs_ops;

/// Per-call context for blocking tools: cancellation and progress, without
/// threading parameters through every function. Unset (tests) means "never
/// cancelled, progress ignored".
pub mod ctx {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub struct Ctx {
        pub cancel: Arc<AtomicBool>,
        pub progress: tokio::sync::mpsc::UnboundedSender<String>,
    }

    thread_local! {
        static CURRENT: RefCell<Option<(Ctx, Instant)>> = const { RefCell::new(None) };
    }

    /// Runs `f` with `c` as the current context on this thread.
    pub fn with<R>(c: Ctx, f: impl FnOnce() -> R) -> R {
        CURRENT.with(|cur| *cur.borrow_mut() = Some((c, Instant::now() - Duration::from_secs(1))));
        let r = f();
        CURRENT.with(|cur| *cur.borrow_mut() = None);
        r
    }

    pub fn cancelled() -> bool {
        CURRENT.with(|cur| cur.borrow().as_ref().is_some_and(|(c, _)| c.cancel.load(Ordering::Relaxed)))
    }

    /// Progress text for the UI, at most every 400 ms.
    pub fn report(msg: impl Into<String>) {
        CURRENT.with(|cur| {
            if let Some((c, last)) = cur.borrow_mut().as_mut() {
                if last.elapsed() >= Duration::from_millis(400) {
                    *last = Instant::now();
                    let _ = c.progress.send(msg.into());
                }
            }
        });
    }
}

/// Tools that may run for minutes (bulk file work): longer limit, progress, Stop between items.
pub fn is_long_running(name: &str) -> bool {
    matches!(name, "search_files" | "find_duplicates" | "move_files" | "copy_files" | "delete_files" | "rename_files" | "organize_files")
}
pub const LONG_TOOL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub mod paths;

use std::borrow::Cow;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use paths::PathGuard;

/// Per-call execution limit.
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    /// Reads only; safe to run concurrently.
    Read,
    /// Creates or changes files.
    Write,
    /// Drives the managed browser (stateful; runs one at a time).
    Browser,
    /// Inspects or controls desktop app windows (Windows UI Automation).
    Desktop,
    /// Long-term memory notes (saving and forgetting always ask).
    Memory,
    /// System status and approved system actions.
    System,
    /// Microsoft Graph: Outlook mail and calendar.
    Graph,
    /// Google Workspace: Gmail and Google Calendar.
    Google,
    /// Clipboard text.
    Clipboard,
    /// Deletes files (to the Recycle Bin); always asks.
    Delete,
}

pub struct ToolSpec {
    pub name: &'static str,
    /// Short human label for the UI.
    pub title: &'static str,
    pub description: &'static str,
    pub kind: ToolKind,
    parameters: fn() -> Value,
}

pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "list_files",
        title: "List files",
        description: "List files and subdirectories in a permitted folder. Set recursive to include subfolders (up to 3 levels, 500 entries).",
        kind: ToolKind::Read,
        parameters: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path, absolute or relative to the permitted folder." },
                "recursive": { "type": "boolean", "description": "Include subfolders." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "read_file",
        title: "Read file",
        description: "Read a UTF-8 text file from a permitted folder (first 200 KB).",
        kind: ToolKind::Read,
        parameters: || json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "File path." } },
            "required": ["path"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "create_directory",
        title: "Create folder",
        description: "Create a directory (and missing parents) inside a permitted folder.",
        kind: ToolKind::Write,
        parameters: || json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "Directory path to create." } },
            "required": ["path"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "write_file",
        title: "Write file",
        description: "Create a text file, or replace an existing one when overwrite is true, inside a permitted folder. The parent directory must exist.",
        kind: ToolKind::Write,
        parameters: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path." },
                "content": { "type": "string", "description": "Full text content to write." },
                "overwrite": { "type": "boolean", "description": "Replace the file if it already exists." }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "browser_open",
        title: "Open page",
        description: "Open a public http(s) URL in the managed browser. Returns the final URL, title and HTTP status. Local network and internal addresses are blocked.",
        kind: ToolKind::Browser,
        parameters: || json!({
            "type": "object",
            "properties": { "url": { "type": "string", "description": "Absolute http(s) URL." } },
            "required": ["url"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "browser_get_page_content",
        title: "Read page",
        description: "Get the current page's readable text, links, and interactive elements. Each element has a ref (e.g. e12) for browser_click / browser_type; refs expire when the page changes.",
        kind: ToolKind::Browser,
        parameters: || json!({
            "type": "object",
            "properties": { "max_chars": { "type": "integer", "description": "Text limit, 500–12000 (default 12000)." } },
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "browser_click",
        title: "Click",
        description: "Click an element by its ref from browser_get_page_content. Clicks that submit a form need the user's approval.",
        kind: ToolKind::Browser,
        parameters: || json!({
            "type": "object",
            "properties": { "ref": { "type": "string", "description": "Element ref, e.g. e12." } },
            "required": ["ref"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "browser_type",
        title: "Type",
        description: "Replace the text in an input or textarea (by ref). Set submit to press Enter afterwards; submitting needs the user's approval.",
        kind: ToolKind::Browser,
        parameters: || json!({
            "type": "object",
            "properties": {
                "ref": { "type": "string", "description": "Element ref of a text field." },
                "text": { "type": "string" },
                "submit": { "type": "boolean", "description": "Press Enter after typing." }
            },
            "required": ["ref", "text"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "browser_search",
        title: "Web search",
        description: "Search the web and return result titles, URLs and snippets.",
        kind: ToolKind::Browser,
        parameters: || json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "browser_download",
        title: "Download file",
        description: "Download a file (by URL, or by clicking an element ref) into a permitted folder. Existing files are never overwritten. Max 50 MB. Needs the user's approval.",
        kind: ToolKind::Browser,
        parameters: || json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "File URL (use this or ref)." },
                "ref": { "type": "string", "description": "Element ref that starts the download (use this or url)." },
                "directory": { "type": "string", "description": "Permitted folder to save into." },
                "filename": { "type": "string", "description": "Optional file name." }
            },
            "required": ["directory"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_list_windows",
        title: "List windows",
        description: "List visible top-level desktop app windows with their handle, title and executable.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": {  },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_list_installed",
        title: "List installed apps",
        description: "List installed apps from the Start menu (name and shortcut path). Only apps on the user's allowed-apps list can be launched.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_launch",
        title: "Launch app",
        description: "Start an app from the user's allowed-apps list (an .exe or Start-menu .lnk path, or its name without the extension). No arguments are passed. Needs the user's approval.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "app": { "type": "string", "description": "Allowed app path or name." } },
            "required": ["app"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_focus",
        title: "Focus window",
        description: "Bring a window to the front.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "window": { "type": "integer", "description": "Window handle from app_list_windows." } },
            "required": ["window"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_get_ui_tree",
        title: "Read window",
        description: "Get a window's named UI elements (buttons, fields, text). Each has a ref (e.g. e3_12) for app_click / app_type; only refs from the latest read are valid.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "window": { "type": "integer", "description": "Window handle from app_list_windows." } },
            "required": ["window"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_click",
        title: "Click in app",
        description: "Activate an element by ref (invoke, toggle, select or expand). Needs the user's approval.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "ref": { "type": "string", "description": "Element ref from app_get_ui_tree, e.g. e3_12." } },
            "required": ["ref"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_select_option",
        title: "Choose option",
        description: "Choose an item by its visible name inside a list, combo box or menu (by ref). Needs the user's approval.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": {
                "ref": { "type": "string", "description": "Ref of the list or combo box from app_get_ui_tree, e.g. e3_12." },
                "option": { "type": "string", "description": "Visible name of the item to choose." }
            },
            "required": ["ref", "option"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_type",
        title: "Type in app",
        description: "Replace the text of an editable field by ref. Password fields are refused. Needs the user's approval.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "ref": { "type": "string", "description": "Element ref from app_get_ui_tree, e.g. e3_12." }, "text": { "type": "string" } },
            "required": ["ref", "text"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_screenshot_analyze",
        title: "Analyze screenshot",
        description: "Take a screenshot of a window and have the vision model describe it (layout, controls, visible text), optionally answering a question. Use it when app_get_ui_tree isn't enough, e.g. custom-drawn UIs. The image is sent to the AI provider; needs the user's approval.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": {
                "window": { "type": "integer", "description": "Window handle from app_list_windows." },
                "question": { "type": "string", "description": "What to look for (optional)." }
            },
            "required": ["window"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "memory_save",
        title: "Remember",
        description: "Save a short long-term note (user preference, project context, ongoing task) for future conversations. Only for things the user would want remembered; never secrets or passwords. Needs the user's approval.",
        kind: ToolKind::Memory,
        parameters: || json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "The note, at most 500 characters." },
                "category": { "type": "string", "enum": ["preference", "project", "task", "other"] }
            },
            "required": ["text", "category"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "memory_forget",
        title: "Forget",
        description: "Delete a long-term note by its id (shown in the memory list in your instructions). Needs the user's approval.",
        kind: ToolKind::Memory,
        parameters: || json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_status",
        title: "System status",
        description: "Read CPU load, memory, fixed drives' free space, internet route and the top processes by memory (with pids).",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_end_process",
        title: "End process",
        description: "End (force-quit) an ordinary user process by pid from system_status. Windows system processes, administrator processes and this app are refused. Always needs the user's approval.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": { "pid": { "type": "integer" } },
            "required": ["pid"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "mail_search",
        title: "Search mail",
        description: "Search or list Outlook messages (newest first without a query). Returns id, subject, sender, time, preview.",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "query": { "type": "string", "description": "Search words (optional)." }, "unread_only": { "type": "boolean" }, "top": { "type": "integer", "description": "1-25, default 10." } },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "mail_read",
        title: "Read email",
        description: "Read one Outlook message by id (plain-text body, up to 20,000 characters).",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "mail_create_draft",
        title: "Draft email",
        description: "Create an Outlook draft (optionally as a reply to a message id). Never sends. Use mail_send_draft to send.",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "to": { "type": "array", "items": { "type": "string" } }, "cc": { "type": "array", "items": { "type": "string" } }, "subject": { "type": "string" }, "body": { "type": "string", "description": "Plain text." }, "reply_to_id": { "type": "string" } },
            "required": ["to", "subject", "body"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "mail_send_draft",
        title: "Send email",
        description: "Send an existing draft by id. Always asks the user, showing the real recipients and subject.",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "calendar_list",
        title: "Read calendar",
        description: "List calendar events between two UTC times (max 50).",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "start": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." }, "end": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." } },
            "required": ["start", "end"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "calendar_availability",
        title: "Check availability",
        description: "Busy times for the user (and optional attendees) between two UTC times, in 30-minute slots.",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "start": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." }, "end": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." }, "attendees": { "type": "array", "items": { "type": "string" } } },
            "required": ["start", "end"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "calendar_create_event",
        title: "Create event",
        description: "Create a calendar event; attendees receive invitations. Always asks the user.",
        kind: ToolKind::Graph,
        parameters: || json!({
            "type": "object",
            "properties": { "subject": { "type": "string" }, "start": { "type": "string", "description": "Local date-time without offset, e.g. 2026-10-25T09:00:00." }, "end": { "type": "string" }, "time_zone": { "type": "string", "description": "Windows or IANA time zone of start/end, e.g. Europe/Berlin." }, "attendees": { "type": "array", "items": { "type": "string" } }, "location": { "type": "string" }, "body": { "type": "string" } },
            "required": ["subject", "start", "end", "time_zone"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gmail_search",
        title: "Search Gmail",
        description: "Search Gmail with Gmail search syntax (e.g. from:alice is:unread newer_than:7d), newest first. Returns id, subject, sender, date, snippet.",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "query": { "type": "string" }, "top": { "type": "integer", "description": "1-25, default 10." } },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gmail_read",
        title: "Read Gmail message",
        description: "Read one Gmail message by id (plain text, up to 20,000 characters).",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gmail_create_draft",
        title: "Draft Gmail",
        description: "Create a Gmail draft (optionally replying in the thread of a message id). Never sends. Use gmail_send_draft to send.",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "to": { "type": "array", "items": { "type": "string" } }, "cc": { "type": "array", "items": { "type": "string" } }, "subject": { "type": "string" }, "body": { "type": "string", "description": "Plain text." }, "reply_to_id": { "type": "string" } },
            "required": ["to", "subject", "body"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gmail_send_draft",
        title: "Send Gmail",
        description: "Send a Gmail draft by draft id. Always asks the user, showing the real recipients and subject.",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "Draft id from gmail_create_draft." } },
            "required": ["id"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gcal_list",
        title: "Read Google Calendar",
        description: "List primary Google Calendar events between two UTC times (max 50, recurring events expanded).",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "start": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." }, "end": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." } },
            "required": ["start", "end"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gcal_availability",
        title: "Google free/busy",
        description: "Busy times for the user's primary calendar and optional attendees between two UTC times.",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "start": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." }, "end": { "type": "string", "description": "ISO date-time in UTC without offset, e.g. 2026-10-25T09:00:00." }, "attendees": { "type": "array", "items": { "type": "string" } } },
            "required": ["start", "end"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "gcal_create_event",
        title: "Create Google event",
        description: "Create a primary Google Calendar event; attendees are emailed invitations. Always asks the user.",
        kind: ToolKind::Google,
        parameters: || json!({
            "type": "object",
            "properties": { "subject": { "type": "string" }, "start": { "type": "string", "description": "Local date-time without offset, e.g. 2026-10-25T09:00:00." }, "end": { "type": "string" }, "time_zone": { "type": "string", "description": "IANA time zone, e.g. Europe/Berlin." }, "attendees": { "type": "array", "items": { "type": "string" } }, "location": { "type": "string" }, "body": { "type": "string" } },
            "required": ["subject", "start", "end", "time_zone"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "search_files",
        title: "Search files",
        description: "Find files in a permitted folder by name (* wildcards), extension, modified date, size and/or text inside them (text files up to 2 MB; returns line and snippet). Up to 200 matches.",
        kind: ToolKind::Read,
        parameters: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "pattern": { "type": "string", "description": "Name pattern, e.g. *.pdf (default all)." },
                "recursive": { "type": "boolean" },
                "contains": { "type": "string", "description": "Text to find inside files (case-insensitive)." },
                "extensions": { "type": "array", "items": { "type": "string" } },
                "modified_after": { "type": "string", "description": "YYYY-MM-DD" },
                "modified_before": { "type": "string", "description": "YYYY-MM-DD" },
                "min_size": { "type": "integer", "description": "Bytes." },
                "max_size": { "type": "integer", "description": "Bytes." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "find_duplicates",
        title: "Find duplicates",
        description: "Find files with identical content in a permitted folder. Read-only; reports groups and reclaimable space.",
        kind: ToolKind::Read,
        parameters: || json!({
            "type": "object",
            "properties": { "path": { "type": "string" }, "recursive": { "type": "boolean" } },
            "required": ["path"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "move_files",
        title: "Move/rename files",
        description: "Move or rename up to 500 files or folders inside permitted folders in one batch (across drives: copy, verify, then remove the source). The user sees every move before it runs; each result is checked on disk. Never overwrites unless overwrite is true.",
        kind: ToolKind::Write,
        parameters: || json!({
            "type": "object",
            "properties": { "moves": { "type": "array", "items": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string", "description": "Full destination path including the file name." } }, "required": ["from", "to"], "additionalProperties": false } }, "overwrite": { "type": "boolean" } },
            "required": ["moves"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_window",
        title: "Manage window",
        description: "Minimize, maximize, restore, snap to left_half/right_half, move_resize (pixels) or close (gracefully; the app may ask to save) a window. The result is checked.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "window": { "type": "integer", "description": "Window handle from app_list_windows." }, "action": { "type": "string", "enum": ["minimize", "maximize", "restore", "left_half", "right_half", "move_resize", "close"] }, "x": { "type": "integer" }, "y": { "type": "integer" }, "width": { "type": "integer" }, "height": { "type": "integer" } },
            "required": ["window", "action"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "app_input",
        title: "Mouse/keyboard input",
        description: "Fallback when UI Automation can't do it: click, double_click, right_click, scroll, drag, keys (e.g. ctrl+s) or type_text in a window. Positions are fractions of the window (from app_screenshot_analyze). The window is brought to the front first. Always asks the user; verify the effect afterwards.",
        kind: ToolKind::Desktop,
        parameters: || json!({
            "type": "object",
            "properties": { "window": { "type": "integer", "description": "Window handle from app_list_windows." }, "action": { "type": "string", "enum": ["click", "double_click", "right_click", "scroll", "drag", "keys", "type_text"] }, "x": { "type": "number", "description": "Fraction 0-1 of the window width/height." }, "y": { "type": "number", "description": "Fraction 0-1 of the window width/height." }, "to_x": { "type": "number", "description": "Fraction 0-1 of the window width/height." }, "to_y": { "type": "number", "description": "Fraction 0-1 of the window width/height." }, "amount": { "type": "integer", "description": "Scroll notches, positive = up." }, "keys": { "type": "string" }, "text": { "type": "string" } },
            "required": ["window", "action"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_set_volume",
        title: "Set volume",
        description: "Set the default speaker volume (0-100) and/or mute. Always asks; the new state is read back.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": { "level": { "type": "integer" }, "mute": { "type": "boolean" } },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_open_settings",
        title: "Open Settings",
        description: "Open a Windows Settings page: display, night_light, sound, bluetooth, network, wifi, battery, power, notifications, focus, apps, default_apps, startup_apps, storage, windows_update, privacy.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": { "page": { "type": "string" } },
            "required": ["page"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "clipboard_read",
        title: "Read clipboard",
        description: "Read the text on the clipboard. Always asks the user.",
        kind: ToolKind::Clipboard,
        parameters: || json!({
            "type": "object",
            "properties": {  },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "clipboard_write",
        title: "Copy to clipboard",
        description: "Put text on the clipboard (e.g. to paste into another app). The result is read back to confirm.",
        kind: ToolKind::Clipboard,
        parameters: || json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "copy_files",
        title: "Copy files",
        description: "Copy files or whole folders (recursively, structure kept, max 20,000 files) inside permitted folders. on_conflict: skip (default), rename (\"name (2).ext\") or overwrite (always asks). Each copy is verified by size and SHA-256.",
        kind: ToolKind::Write,
        parameters: || json!({
            "type": "object",
            "properties": { "copies": { "type": "array", "items": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string", "description": "Full destination path including the file name." } }, "required": ["from", "to"], "additionalProperties": false } }, "on_conflict": { "type": "string", "enum": ["skip", "rename", "overwrite"] } },
            "required": ["copies"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "delete_files",
        title: "Delete files",
        description: "Move up to 100 files (or folders, with include_folders) inside permitted folders to the Recycle Bin. The user sees every target and must approve; permitted folders themselves are protected. Results are checked on disk.",
        kind: ToolKind::Delete,
        parameters: || json!({
            "type": "object",
            "properties": { "paths": { "type": "array", "items": { "type": "string" } }, "include_folders": { "type": "boolean" } },
            "required": ["paths"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_lock",
        title: "Lock computer",
        description: "Lock the Windows session (LockWorkStation). Always asks.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": {  },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "rename_files",
        title: "Batch rename",
        description: "Rename files in one permitted folder using a template ({name} {ext} {n} {n:3} {date} {year} {month}, e.g. Invoice_{n:3}_{date}.{ext}) and/or find/replace. The user sees every new name before anything changes; never overwrites.",
        kind: ToolKind::Write,
        parameters: || json!({
            "type": "object",
            "properties": { "path": { "type": "string" }, "pattern": { "type": "string", "description": "Which files, e.g. *.jpg (default all)." }, "template": { "type": "string" }, "find": { "type": "string" }, "replace": { "type": "string" } },
            "required": ["path"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "organize_files",
        title: "Organize folder",
        description: "Move the files of a permitted folder into subfolders by extension, year or month (created as needed). The user sees every move first; never overwrites.",
        kind: ToolKind::Write,
        parameters: || json!({
            "type": "object",
            "properties": { "path": { "type": "string" }, "by": { "type": "string", "enum": ["extension", "year", "month"] }, "pattern": { "type": "string" } },
            "required": ["path", "by"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_audio_devices",
        title: "Audio devices",
        description: "List active speakers/headphones and microphones and which are the defaults. Changing the default device is done in Settings (no public API).",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": {  },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_set_microphone",
        title: "Microphone mute",
        description: "Mute or unmute the default microphone. Always asks; the new state is read back.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": { "mute": { "type": "boolean" } },
            "required": ["mute"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_wifi_status",
        title: "Wi-Fi status",
        description: "Current Wi-Fi network and visible networks (signal, secured, saved profile).",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": {  },
            "required": [],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_wifi",
        title: "Wi-Fi connect",
        description: "Connect to a visible Wi-Fi network that has a saved profile, or disconnect. Always asks; the result is verified. New networks needing a password are joined in Settings.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": { "action": { "type": "string", "enum": ["connect", "disconnect"] }, "ssid": { "type": "string" } },
            "required": ["action"],
            "additionalProperties": false
        }),
    },
    ToolSpec {
        name: "system_power",
        title: "Power",
        description: "sleep, restart, shutdown (restart/shutdown are scheduled 60 s ahead with a Windows warning so they can be cancelled) or cancel_shutdown. Always asks with a clear warning.",
        kind: ToolKind::System,
        parameters: || json!({
            "type": "object",
            "properties": { "action": { "type": "string", "enum": ["sleep", "restart", "shutdown", "cancel_shutdown"] } },
            "required": ["action"],
            "additionalProperties": false
        }),
    },
];

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.name == name)
}

/// OpenAI `tools` array for the given tools.
pub fn openai_definitions<'a>(specs: impl Iterator<Item = &'a ToolSpec>) -> Value {
    Value::Array(
        specs
            .map(|t| {
                json!({
                    "type": "function",
                    "function": { "name": t.name, "description": t.description, "parameters": (t.parameters)() }
                })
            })
            .collect(),
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    pub kind: &'static str,
}

/// A successful tool result: `content` goes to the model, `summary` to the UI.
#[derive(Debug)]
pub struct ToolOutput {
    pub content: Value,
    pub summary: String,
    pub file: Option<FileChange>,
}

#[derive(Debug, Clone)]
pub struct ToolError {
    pub code: Cow<'static, str>,
    pub message: String,
}

impl ToolError {
    pub fn new(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::new("invalid_arguments", m.into())
    }
    pub fn denied(m: impl Into<String>) -> Self {
        Self::new("permission_denied", m.into())
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new("not_found", m.into())
    }
    pub fn io(path: &Path, e: &std::io::Error) -> Self {
        Self::new("io_error", format!("{}: {e}", paths::display(path)))
    }
    pub fn timeout() -> Self {
        Self::new("timeout", format!("The tool did not finish within {}s.", TOOL_TIMEOUT.as_secs()))
    }

    /// The error as it is reported back to the model.
    pub fn to_json(&self) -> Value {
        json!({ "error": { "code": self.code, "message": self.message } })
    }
}

pub(crate) fn parse<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, ToolError> {
    serde_json::from_value(args.clone()).map_err(|e| ToolError::invalid(format!("Invalid arguments: {e}")))
}

/// Runs a tool synchronously. Callers run this on a blocking thread with a timeout.
pub fn execute(spec: &ToolSpec, args: &Value, guard: &PathGuard) -> Result<ToolOutput, ToolError> {
    match spec.name {
        "list_files" => fs::list_files(guard, parse(args)?),
        "read_file" => fs::read_file(guard, parse(args)?),
        "create_directory" => fs::create_directory(guard, parse(args)?),
        "write_file" => fs::write_file(guard, parse(args)?),
        "search_files" => fs_ops::search_files(guard, parse(args)?),
        "find_duplicates" => fs_ops::find_duplicates(guard, parse(args)?),
        "move_files" => fs_ops::move_files(guard, parse(args)?),
        "copy_files" => fs_ops::copy_files(guard, parse(args)?),
        "delete_files" => fs_ops::delete_files(guard, parse(args)?),
        "rename_files" => fs_ops::rename_files(guard, parse(args)?),
        "organize_files" => fs_ops::organize_files(guard, parse(args)?),
        other => Err(ToolError::invalid(format!("Unknown tool `{other}`."))),
    }
}
