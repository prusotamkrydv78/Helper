# AI Automation

A desktop AI assistant built with Tauri 2, Rust, React 19, TypeScript and Vite.

**Current status:** chat is live through OpenAI when an API key is configured.
The assistant can use four real file tools (list, read, create folder, write
file), but only inside folders you explicitly allow. Automations and the local
PC agent are still simulated. The assistant can also browse the web in a managed browser
and, on Windows, operate desktop app windows (off by default).
There are no shell, delete or code-execution tools.

## Prerequisites (Windows)

- Node.js 20+
- Rust (stable), installed with [rustup](https://rustup.rs)
- Visual Studio Build Tools with **Desktop development with C++**
- WebView2 (preinstalled on Windows 11)

## Setup

```bash
npm install
npm run tauri dev
```

The first run compiles the Rust backend, which takes a few minutes.

### Configure the API key

Use either of these:

1. **In the app (recommended):** open Settings → AI model, paste your OpenAI
   key and click **Save key**. The key is stored in Windows Credential Manager
   (entry `com.helper.app` / `openai-api-key`) and never returned to the UI.
2. **Environment variable:** set `OPENAI_API_KEY`. In development builds, the
   backend also reads `.env` files from the project root or `src-tauri/`:

   ```bash
   cp .env.example .env   # then fill in OPENAI_API_KEY
   ```

   If both are set, the environment variable wins.

Optional settings: `OPENAI_MODEL` sets the default model (the built-in default
is `gpt-4o-mini`; check that your account has access to it), and `OPENAI_BASE_URL`
points the app at an OpenAI-compatible endpoint. You can also set a model per
install in Settings → AI model.

Without a key, chat falls back to a clearly labeled mock, so the UI stays usable.

## File tools

| Tool | What it does | Permission setting |
| --- | --- | --- |
| `list_files` | Lists a folder (optionally 3 levels deep, max 500 entries) | “Read files” (default: allowed) |
| `read_file` | Reads a UTF-8 text file (first 200 KB) | “Read files” |
| `create_directory` | Creates a folder | “Create & modify files” (default: ask first) |
| `write_file` | Creates a text file; replaces one only when `overwrite` is true (max 1 MB) | “Create & modify files” |

**Safety rules (enforced in Rust):**

- Tools only work inside folders added in Settings → Allowed folders. With none added, no tools are offered to the model.
- Every path is canonicalized (symlinks resolved) and must be inside an allowed folder. Paths containing `..` are rejected outright.
- Whole drives can't be added as allowed folders.
- Each call has a 30-second timeout. **Stop** cancels the model stream, pending approvals and running tools.
- The model gets the real tool output. Failures, declined approvals and timeouts go back to it as errors, so it can't report a success that didn't happen.

### Try it

1. Create a test folder (e.g. `C:\Users\<you>\AI Test`) and put a text file in it.
2. In Settings → Allowed folders, click **Add folder…** and choose that folder.
3. In a new chat, ask: *“List the files in my folder, read notes.txt, then write summary.md with its key points.”*
4. Approve the write when asked. The file appears on disk, and the task card shows each tool's real result.
5. Ask it to read `../something.txt`. The backend refuses, and the model tells you so.

Each tool call is logged with its request and call IDs, for example `running read_file (call_…)` followed by `completed in 1.2ms`.

**OpenAI note:** some reasoning models (e.g. `gpt-6-luna`) reject function tools on Chat Completions unless reasoning is off. The app detects that specific error, retries with `reasoning_effort: "none"`, and remembers it for that model. Set `OPENAI_REASONING_EFFORT` to override.

## Browser tools

The assistant can browse the web through a managed Microsoft Edge session driven by
[Playwright](https://playwright.dev). It runs in a separate Node worker
(`browser-worker/worker.mjs`) that the Rust backend starts on first use.

| Tool | What it does | Approval |
| --- | --- | --- |
| `browser_open` | Opens a public http(s) URL | none |
| `browser_get_page_content` | Readable text, links, and interactive elements with refs (`e12`) | none |
| `browser_search` | Web search (DuckDuckGo by default), returns titles/URLs/snippets | none |
| `browser_click` | Clicks an element by ref | “Browser actions” = Ask → every click asks. **Form submissions always ask.** |
| `browser_type` | Fills a text field by ref (optionally presses Enter) | Ask → every entry asks. **Password/payment fields and Enter-to-submit always ask.** |
| `browser_download` | Saves a file into an allowed folder (max 50 MB, never overwrites) | Follows “Create & modify files” (default: ask) |

**Setup:** you need Node.js 20+, `npm install` (installs `playwright-core`) and Microsoft
Edge, which comes with Windows 11. No separate browser download is needed. The browser window is
visible by default, so you can watch what the assistant does; search engines also block
hidden (headless) browsers.

Environment options: `AA_BROWSER_HEADLESS=1` hides the window, `AA_BROWSER_CHANNEL`
picks the browser (`msedge`, `chrome` or `chromium`), `AA_SEARCH_URL` changes the search engine (Bing
markup is supported too), `AA_NODE_PATH` sets the Node binary, and `AA_BROWSER_WORKER` sets the worker script location.

**Safety (enforced in code, not just in the prompt):**
- **Destinations:** only `http`/`https`. IPv6 forms that embed an IPv4 address (`::ffff:7f00:1`, `::127.0.0.1`, 6to4, Teredo) are treated by the embedded address. The Rust backend checks each URL before the browser loads it: `localhost`, `.local`/`.internal` names, single-label hosts, private/loopback/link-local/CGNAT/metadata IPs, and hosts that *resolve* to such addresses are all refused. Inside the browser, **every** request (navigations, every redirect hop, images, scripts, `fetch`, WebSockets) is checked against the same rules, so a public page can't reach your local network. Requests are fetched by the worker
  process, and its DNS lookups are filtered again at connect time, so a host can't pass the check and then
  re-resolve to a private address (DNS rebinding). Service workers are blocked and WebRTC is kept off local addresses. WebSockets are
  connected by the worker process too (Node 22+), so they get the same connect-time check; on older Node
  the browser connects them after the URL check, without the rebinding guard. Proxied WebSockets don't
  carry browser cookies or subprotocols.
- **Approvals** come from inspecting the real element, not from the model's description. For example, clicking a button that submits a form asks “Submits a form (“Send”) to https://…”.
- **File uploads** aren't supported. Downloads go only into allowed folders, file names are sanitized, and the saved path is checked again afterwards.
- **Untrusted content:** page text, links and search results reach the model labeled as untrusted data, and the system prompt tells it never to follow instructions found on pages.
- **Session lifecycle:** one session; per-action timeouts (25–120 s). **Stop**, or a timeout, closes the browser session (the next call starts a fresh one). The session also closes after 5 idle minutes and when the app exits.

**Tested live** (through the app with a real model): searching the public web, opening a real page and reading it;
filling and submitting a form on a controlled test page, with the approval prompt; and a
prompt-injection page, whose planted instructions were ignored. Downloads, the address
blocking and redirects are covered by the automated tests against local pages. A live
download from a public site hasn't been tested.

## Command Center

The **Command Center** page (first in the sidebar) shows live state only: pending approvals (approve or
decline in place), the running workflow's progress, workflows needing attention, the next scheduled runs,
Microsoft 365 / Google connection status with connect/reconnect, a system snapshot (`system_status_now`,
read-only, refreshed on demand) and recent tool activity (activity log, polled every 10 s).
Quick actions (open an app, search email, today's calendar, unread mail, diagnose the system) start a normal
chat, so tools run under your permissions and approvals; *Start* runs a draft or paused workflow directly.

## Managing data

Settings → **Data on this device** deletes each kind of data separately, each after a confirmation: chats &
tasks (a workflow whose conversation was deleted continues its next step in a new one), workflows with their
conversations (refused while one is running), schedules, memory, the activity log, and the Microsoft 365 /
Google connections (tokens deleted; Google access is also revoked). Settings and permissions are kept.

The old demo *Automations* page and *Local PC agent* status were removed from the UI: workflows + schedules
and the Rust backend replace them. The *Sandbox mode* switch was removed because file tools are always
confined to allowed folders.

## Workflows

The **Workflows** page turns a goal into ordered steps (planned by the model without tools, or typed
yourself, editable before starting) and runs them one at a time. Each step is a normal chat turn in the
workflow's own conversation, so it uses the same tools, permissions, approvals, task cards and Stop as chat.
The model must end each step with `STEP RESULT: SUCCESS` or `STEP RESULT: FAILED - reason`; a missing line,
an error, or demo mode counts as failed.

- **Controls:** start, pause (after the current step), resume, cancel (aborts the running step, its pending
  approvals and tools), retry or skip a failed/interrupted step, delete.
- **Persistence:** saved by the backend to `workflows.json` in the app config folder (atomic write). A step is
  saved as running *before* it starts; after a crash or restart it becomes **interrupted** and is never
  re-run automatically, because it may already have had effects. You decide to retry or skip it.
- **One workflow runs at a time** (tools such as the browser session are shared).

### Schedules

Under Workflows → **Schedules**, a workflow can run once, daily, weekly (chosen days) or every N minutes
(at least 15). Schedules are saved by the backend (`schedules.json`). Every run starts a **fresh copy** of the
workflow's steps through the workflow engine, so permissions, approvals and Stop apply as usual, and steps of
an earlier (possibly interrupted) run are never repeated.

- **Only while the app is open.** There is no background service: nothing runs while the app is closed.
  Runs that were due while the app was closed or the computer slept (more than 10 minutes late) are either
  skipped or caught up **once**, as chosen per schedule.
- **No duplicates:** the next run time is advanced and saved before a run starts. If another workflow is
  running, a due run waits up to an hour, then is skipped and noted.
- **Time zones:** times are local wall-clock times on this computer (DST-aware). The zone a schedule was
  created in is shown if the computer's zone has changed since.
- Unattended steps that need approval wait in the run's conversation until you answer.

## Memory, activity log, system tools and background mode

- **Memory** (`memory.json`): short notes (preferences, project context, ongoing tasks). Add, inspect and
  delete them in Settings → Memory. The assistant can propose `memory_save` / `memory_forget`, which always
  need your approval. Notes are sent to the AI provider as context; don't store secrets.
- **Activity log** (`audit.log`, rotated at 5 MB): every tool call that completed, failed or was declined,
  with shortened arguments (file contents and typed text are replaced by their length). Settings → Activity log.
- **System tools** (“System info & actions” permission, default Ask): `system_status` (CPU, memory, fixed
  drives, internet route + local IP, top processes by memory) and `system_end_process` (always asks; Windows
  system processes, administrator processes and this app are refused).
- **Screenshot analysis**: `app_screenshot_analyze` captures one window (same window rules as the other desktop
  tools), downscales it to 1600 px wide and sends it to the configured model with your question. Always asks
  first; images aren't stored. Needs a vision-capable model (e.g. `gpt-4o-mini`). Results can be wrong, so the
  agent is told to confirm with `app_get_ui_tree` before acting.
- **Background** (Settings → Background & notifications): tray icon (Show/Quit), optional close-to-tray so
  schedules keep running, *Start with Windows* (starts hidden, via `tauri-plugin-autostart`), and desktop
  notifications (`tauri-plugin-notification`) for approvals and finished workflows while the app isn't focused.
  Windows may suppress notifications (Focus Assist / notification settings).
- **Agent behaviour:** the system prompt asks the model to plan, verify each outcome, try one alternative on
  failure, and ask you a specific question when blocked.

**Not implemented:** notes and messaging integrations.

## Microsoft 365 (Outlook mail and calendar)

Tools (permission “Microsoft 365 mail & calendar”, default Ask; offered only while connected):

| Tool | What it does | Approval |
| --- | --- | --- |
| `mail_search` | List/search messages (id, subject, sender, time, preview) | per permission |
| `mail_read` | Read one message as plain text (max 20,000 characters) | per permission |
| `mail_create_draft` | Create a draft or reply draft — never sends | per permission |
| `mail_send_draft` | Send a draft | **always**, showing the draft's real recipients and subject |
| `calendar_list` | Events between two UTC times (max 50) | per permission |
| `calendar_availability` | Busy times for you and optional attendees (30-min slots) | per permission |
| `calendar_create_event` | Create an event; attendees get invitations | **always** |

Summaries are done by the model from `mail_read` results. Mail and calendar content is labeled untrusted.

### What you must configure (one time)

1. Sign in to <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
   - Name: e.g. *AI Automation*.
   - Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*
     (or only your organization — then put your tenant ID/domain in Settings).
   - Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost`.
     (Microsoft accepts any port on `localhost` for this platform; the app picks a free one each sign-in.)
2. In the app's **Authentication** page, set **Allow public client flows** to *Yes*. No client secret is used.
3. **API permissions → Add → Microsoft Graph → Delegated**: `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
   `Calendars.ReadWrite`, `offline_access`. Some organizations require an admin to grant consent.
4. Copy the **Application (client) ID** into Settings → Microsoft 365 (or set `MS_GRAPH_CLIENT_ID`), click
   **Save**, then **Connect Microsoft account** and finish sign-in in the browser.

**How it works:** OAuth 2.0 authorization code with PKCE and a one-shot loopback redirect
(`http://localhost:<random port>`, state checked). The refresh token is stored in Windows Credential Manager
(entries `com.helper.app` / `ms-graph-refresh-*`); access tokens stay in memory and are refreshed
automatically. If Microsoft rejects the refresh token (expired or revoked), the account is disconnected and
you're asked to connect again. **Disconnect** deletes the stored tokens. Tokens never reach the model, the UI
or the logs. Graph throttling (429/503) is retried once.

**Limits:** times for reading are UTC (the model converts); no attachments; plain-text bodies only; one account.

## Google Workspace (Gmail and Google Calendar)

Tools (permission “Google Gmail & Calendar”, default Ask; offered only while connected):

| Tool | What it does | Approval |
| --- | --- | --- |
| `gmail_search` | Search with Gmail syntax (`from:`, `is:unread`, `newer_than:7d`…) | per permission |
| `gmail_read` | Read one message as plain text (HTML is converted; max 20,000 characters) | per permission |
| `gmail_create_draft` | Create a draft, or a reply draft in the original thread — never sends | per permission |
| `gmail_send_draft` | Send a draft | **always**, showing the draft's real recipients and subject |
| `gcal_list` | Primary-calendar events between two UTC times (max 50) | per permission |
| `gcal_availability` | Free/busy for you and optional attendees | per permission |
| `gcal_create_event` | Create an event; attendees are emailed invitations | **always** |

### What you must configure (one time)

1. In <https://console.cloud.google.com> create (or pick) a project.
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): user type *External* (or *Internal* for a
   Workspace org), app name and support email. Under **Data access / Scopes** add
   `gmail.readonly`, `gmail.compose`, `calendar.events`, `calendar.freebusy`, plus `openid` and `email`.
   While the app is in **Testing**, add your Google account under **Test users**.
   Note: Gmail scopes are *restricted*; a Testing-mode app works for its test users, but Google expires its
   refresh tokens after **7 days** (you'll be asked to connect again). Publishing for other users requires
   Google's verification.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Desktop app**.
   Copy the client ID and client secret into Settings → Google Workspace, click **Save**, then
   **Connect Google account**. (Desktop clients accept any loopback port; the app uses `http://127.0.0.1:<port>`.)

**How it works:** same as Microsoft 365: authorization code + PKCE, state check, one-shot loopback redirect.
All requested scopes must be granted or the connection is refused. The refresh token and the client secret are
stored in Windows Credential Manager (`com.helper.app` / `google-refresh-*`, `google-client-secret-*`); access
tokens stay in memory. **Disconnect** revokes the grant at Google and deletes local tokens. Draft headers are
sanitized (no line breaks in addresses or subjects) so content can't inject extra recipients.

**Limits:** primary calendar only; no attachments; one account; Testing-mode tokens expire weekly.

## Laptop control

| Tool | What it does | Approval |
| --- | --- | --- |
| `app_window` | minimize / maximize / restore / left_half / right_half / move_resize / close (WM_CLOSE, the app may ask to save); the resulting state is checked | close always; others when Desktop apps = Ask |
| `app_input` | Fallback input: click, double/right click, scroll, drag, key combos, typing. Positions are fractions of the window (as reported by `app_screenshot_analyze`). The window is brought to the front and must *be* the foreground window before anything is sent | **always**; needs the *Mouse & keyboard input* permission (default Deny) and Desktop apps |
| `search_files` | Find files by name (`*` wildcards) in allowed folders | Read files |
| `find_duplicates` | Identical-content groups (SHA-256) and reclaimable space; read-only | Read files |
| `move_files` | Batch move/rename (max 100) inside allowed folders; the approval lists every move; each result is checked on disk; never overwrites unless asked | per *Create & modify files*; **always** when overwriting |
| `copy_files` | Batch copy (max 100 files) inside allowed folders; `on_conflict` skip / rename (`name (2).ext`) / overwrite; each copy verified by size + SHA-256 | per *Create & modify files*; **always** when replacing files |
| `delete_files` | Move files (and, with `include_folders`, folders up to 2,000 files) inside allowed folders to the **Recycle Bin**; the approval lists every target; permitted folders themselves are protected; results checked on disk | **always**; needs *Delete files* (default Deny) |
| `rename_files` | Rename files in a folder by template (`{name} {ext} {n} {n:3} {date} {year} {month}`) and/or find/replace; every new name is previewed; never overwrites | per *Create & modify files* |
| `organize_files` | Move a folder's files into subfolders by extension, year or month (created as needed); previewed | per *Create & modify files* |
| `system_audio_devices` | Speakers/headphones and microphones, with the defaults marked (changing the default device has no public API → Settings) | per System permission |
| `system_set_microphone` | Mute/unmute the default microphone; read back | **always** |
| `system_wifi_status` / `system_wifi` | Current and visible networks (Native Wifi API); connect to a network with a **saved profile**, or disconnect (warns that the assistant may go offline); verified | status per System; connect/disconnect **always** |
| `system_power` | sleep, restart, shutdown (scheduled 60 s ahead with a Windows warning, cancellable via `cancel_shutdown` or `shutdown /a`) | **always**, with warnings |
| `system_lock` | Lock the session (`LockWorkStation`) | **always** |
| `system_set_volume` | Default speaker volume / mute (Core Audio); the new state is read back | **always** |
| `system_open_settings` | Opens an allow-listed Windows Settings page (`ms-settings:` URIs) | per System permission |
| `clipboard_read` / `clipboard_write` | Clipboard text; writing is read back to confirm | read **always**; write per *Clipboard* permission (default Deny) |

`system_status` now also reports battery (charge, AC, time left) and volume/mute.

**Safety:** input is refused for this app, elevated windows, UAC/sign-in prompts and hung windows (same rules as
the other desktop tools); typing and key presses are refused when the focused field is a password field;
Windows-key shortcuts and Ctrl+Alt+Del are refused. Input effects can't be verified generically, so the tool
says so and the agent is told to re-read the window. No file deletion tool exists.

**Long file operations** (search, duplicates, move, copy, delete, rename, organize) run up to 30 minutes,
show live progress on the task card, and stop between items when you press Stop: the result lists what was
completed and verified (also recorded in the activity log as `cancelled`); nothing else is touched.
`copy_files` copies folders recursively (structure, empty folders, max 20,000 files) and verifies every file by
SHA-256; `move_files` moves across drives by copy → verify → delete source. `search_files` also filters by
extension, date (UTC), size and text inside files (text files ≤ 2 MB, returns line + snippet).

**Visual automation checks:** pointer input (click/scroll/drag) needs a screenshot of that window taken
in the last 2 minutes while the window had its current position and size (`stale_screenshot` otherwise);
right before each pointer action the window must still be in front (`focus_changed`) and must be the window
under the point (`point_covered`, e.g. a dialog popped up). Windows without usable UI Automation elements say
so and point to screenshot analysis.

**Settings:** `system_open_settings` returns `direct_control`, saying what can be changed directly (volume,
mute, lock) and why other toggles (brightness, Night light, Focus, radios) must be changed on the page.

**OS limits:** laptop screen brightness needs WMI (not supported here; `system_open_settings` → `display`
instead); moving files across drives isn't supported (rename only); Windows ignores synthetic input sent to
elevated windows (UIPI) and to the secure desktop; some apps (games, DRM video) don't respond to synthetic
input or can't be captured. Coordinates assume the app is DPI-aware (Tauri is), so window rectangles and
input positions use the same physical pixels.

## Clipboard history, app actions, file rules, shortcuts and voice

- **Clipboard history** (Settings → Clipboard, off by default): text and images, memory only, cleared when
  turned off or on exit; up to 50 items / 5 images, pinning, search, copy back. Content marked private by its
  app (`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory` = 0) is never captured;
  text that looks like a password, key, token or card number is skipped. Tools `clipboard_history` (always asks)
  and `clipboard_restore` need the Clipboard permission.
- **App actions:** `open_file` (document from an allowed folder with its default app; programs and scripts are
  refused), `app_menu` (menu path like File › Save As, including popup menus; always asks), `app_fill_form`
  (fields by label, all matched before anything changes, values read back, password fields refused, nothing
  submitted; always asks).
- **File rules** (Settings → File rules): saved organize rules (by type, year, month or a folder pattern such as
  `Photos/{year}/{month}`), preview + confirm before applying. Moves, renames and organizing are recorded in an
  undo history (last 20, `file_undo.json`); undo moves files back after a preview and refuses to overwrite.
  Tools: `organize_files` (with `target` / `extensions`), `list_file_changes`, `undo_file_changes`.
- **Global shortcuts** (Settings → Shortcuts, off by default): show JARVIS, start voice input, pause the running
  workflow, stop all automation (cancels every running request and pending approval).
- **Voice** (Settings → Voice): push-to-talk via Windows speech recognition (`Windows.Media.SpeechRecognition`;
  needs a microphone and *Online speech recognition* enabled in Windows privacy settings); audio isn't stored.
  Replies can be read aloud with the installed Windows voices (Web Speech synthesis); speaking stops when you
  talk, send or press Stop.
- **Task chaining:** Command Center → *Plan* turns a goal into a draft workflow (editable steps, progress,
  retry/skip, approvals) on the Workflows page.

## Proactive features, workspaces, documents and recovery

- **Notification center** (sidebar → Notifications, unread badge): approvals, completed/failed workflows,
  reminders, triggers and interrupted workflows, with Review and Dismiss. Stored on this device (titles/short
  text only, last 200); also raised as Windows notifications while the app isn't focused.
- **Reminders:** a schedule's action can be *Show a reminder* instead of running a workflow.
- **Triggers** (Workflows → Triggers, opt-in): when an app starts (`excel.exe`), battery drops below N % on
  battery power, or free disk space drops below N GB. Checked every 30 s while the app runs; fires when the
  condition becomes true, respects a cooldown, and the notification says why. Actions: reminder, or a fresh
  workflow run (approvals as usual). Stored in `triggers.json`.
- **Cross-app results:** a successful step may end with a `STEP OUTPUT:` block; it's stored with the step and
  passed in full (≤ 4,000 characters) to later steps, which are told not to repeat completed steps.
- **Templates:** mark a workflow *Save as template*; *Run a copy* starts a fresh run.
- **Recovery:** steps are checkpointed before they start; after a restart, interrupted steps are flagged in the
  notification center and retrying one asks for confirmation (it may repeat side effects).
- **Workspaces** (Settings → Workspaces): save open windows' positions/sizes/states under a name; restoring
  shows a preview, arranges matching open windows (verified), reports missing apps and only launches them if
  they're on the allowed-apps list. Tool `workspace_layouts` (apply asks first). Virtual desktops aren't
  restored (Windows only lets apps move their own windows between desktops).
- **Ask your documents** (Settings → Documents) and tool `document_search`: local TF-IDF ranking of paragraphs
  in text documents (txt, md, csv, json, html, xml, yaml, ini, log…) of an allowed folder, with file names, line
  numbers and excerpts. The Settings page searches locally and only sends the shown passages to the AI after
  you confirm. (The tool's excerpts go to the model like any tool result, under the Read files permission.)
  PDF and Office files aren't parsed.
- **Preferences:** memory notes now include reusable instructions and preferred apps, and can be edited or
  disabled (disabled notes aren't sent to the model).

## Hands-free voice, screen analysis, browser sessions, library, skills and task control

- **Hands-free conversation** (Settings → Voice): a microphone pill shows when the mic is on; flow is
  (optional wake phrase →) listen → reply → speak → listen for a follow-up. Windows speech recognition ends an
  utterance after ~1.2 s of silence and gives up after 8 s without speech. **Mute** stops listening and
  speaking at once; "stop listening" ends it. Nothing is recorded to disk.
- **Screen analysis** (Command Center, opt-in): one screenshot of a chosen window or screen region, sent to the
  vision model only after a confirmation; returns visible text, an explanation and suggested next steps.
  Never continuous.
- **Browser:** `browser_tabs` (list/new/switch/close), `browser_extract` (tables, links, headings, metadata
  incl. JSON-LD), `browser_fill_form` (several fields, never submits; password/payment fields always ask).
  Clicks on buy/pay/checkout/order/subscribe-like buttons always ask with a purchase warning. Optional
  *Keep browser logins* uses a persistent profile in the app data folder (off by default). All address
  blocking applies unchanged.
- **Knowledge library** (Settings → Knowledge library): chosen folders inside allowed folders are indexed
  locally (text documents, ≤ 256 MB of text), re-checked every minute by modification time; local answers with
  file + line citations; "Answer with AI" sends only the shown passages after confirmation. Tool
  `library_search` (Read files permission).
- **Skills** (Settings → Skills, `skills.json`): named step lists, editable, enable/disable, "Run as workflow";
  enabled skills are given to the model to follow on request. The likely required permissions are shown
  (derived from tool names and wording). "Save as skill" on workflow cards.
- **Resource awareness:** before each workflow step, it pauses (with the reason, plus a notification) if the
  session is locked, the battery is below 15 % and not charging, memory use is ≥ 95 % or there's no network.
  Unresponsive apps are already refused by the desktop tools (`app_not_responding`).
- **Running** (sidebar): chat tool tasks, the running workflow and recoverable paused/failed workflows, with
  current action, progress, approvals and Stop. **Stop everything** aborts all replies, voice and speech,
  cancels the workflow, cancels every backend request and pending approval, closes the browser session, and
  lists what couldn't be stopped (e.g. desktop calls waiting on a frozen app).

## Reliable execution and the operator loop

- **Dependencies:** a step may start with `[after 1, 3]` (the planner adds this where useful); without it a
  step depends on all earlier steps. When a step fails, steps that don't depend on it still run; the rest wait
  until you retry or skip it.
- **Evidence:** each step records its turn's tool calls and real outcomes (completed / failed / declined /
  cancelled). Completed calls that aren't read-only count as side effects.
- **Retries:** a technical failure (model or network error) where **no side-effect action completed** is
  retried automatically once after 5 s. Any other retry is manual, and if the step's evidence shows completed
  side effects (or it was interrupted by a restart), the retry dialog lists them and asks first.
- **Recovery guidance:** failed steps with completed side effects say what wasn't undone and where to undo it
  (File rules undo history, Recycle Bin, or the service itself).
- **Operator loop (enforced):** after every desktop action (click, type, select, fill, menu, input, window,
  focus), element refs and screenshot records are cleared, so the next action needs a fresh inspection
  (`inspect_first` / `stale_screenshot` otherwise), in addition to the focus, covered-point and
  unsupported-control checks.
- **Running view:** the active workflow shows its goal, current step and action with progress, recent evidence,
  cancellation state, plus approvals and retry safety for paused/failed workflows.

## Personal context, daily briefing and diagnostics

- **Personal context:** memory notes can be preferences, explicit **corrections**, reusable instructions or
  preferred apps (review, edit, disable, delete in Settings → Memory; saving from chat always asks). While you
  type, matching enabled skills and workflow templates appear as chips under the chat box; nothing runs
  unless you click one, and its steps still ask before consequential actions.
- **Daily briefing** (Settings → Daily briefing, off by default): once a day after the chosen time (or when the
  app opens later that day) a briefing is assembled locally — calendar events read directly from connected
  Microsoft/Google accounts for the next N hours (each account says ok / not connected / unavailable), today's
  reminders, pending approvals, interrupted and unfinished workflows. No AI writes it. It's shown on the
  Command Center with its timestamp ("Refresh now" rebuilds it) and announced as a notification.
- **Diagnostics** (Settings → Diagnostics): read-only configuration checks (API key present, browser worker,
  Node.js, Edge, allowed folders, Microsoft/Google connection, clipboard history, shortcuts, knowledge library,
  app data files and any set-aside corrupt files, stuck desktop actions, workflow recovery, permissions) —
  nothing is started or sent. Separate **tests** run only on click (start the browser, listen once, speak,
  send a notification) and show "Tested at …: passed/failed".

## Desktop app tools (Windows)

The assistant can read and operate other apps' windows through Windows UI Automation
(`src-tauri/src/desktop/`). It uses accessibility patterns (Invoke, Toggle, Select, Expand, Value),
never synthetic mouse or keyboard input or screenshots.

| Tool | What it does | Approval |
| --- | --- | --- |
| `app_list_windows` | Visible top-level windows: handle, title, executable | none |
| `app_get_ui_tree` | A window's named elements (max 300), each with a ref like `e3_12` | none |
| `app_focus` | Brings a window to the front | when “Desktop apps” = Ask |
| `app_list_installed` | Installed apps from the Start menu (name + shortcut path) | none |
| `app_launch` | Starts an allow-listed `.exe` (no arguments, no shell) or opens an allow-listed Start-menu `.lnk` | always |
| `app_select_option` | Chooses a named item in a list/combo box/menu (expand → select/invoke) | always |
| `app_click` | Invokes/toggles/selects/expands an element by ref; falls back to the MSAA default action | always |
| `app_type` | Sets the text of an editable field by ref (max 10,000 characters) | always |

**Setup:** set Settings → Tool permissions → “Desktop apps” to Ask or Allow (default: Deny, which hides
the tools). To allow launching, list full `.exe` paths, one per line, under “Allowed apps”;
`app_launch` accepts a listed path or its file name without `.exe`, and is hidden while the list is empty.

**Safety (enforced in Rust):**
- Refused: this app's own windows, elevated (administrator) processes, processes that can't be inspected,
  and UAC, credential and lock-screen UI (`consent.exe`, `CredentialUIBroker.exe`, `LogonUI.exe`, `LockApp.exe`).
- Password fields can't be clicked or typed into.
- Only refs from the latest `app_get_ui_tree` work. Before acting, the element is looked up again and its name
  and type must still match, otherwise the call fails with `stale_ref`.
- Approval prompts describe the real element, e.g. *Click button “Save” in “Untitled - Notepad”*.
- Window and element text reaches the model labeled as untrusted.

Documents and text fields include their visible text (Value or Text pattern, up to 4,000 characters).
Hung windows (`IsHungAppWindow`) are refused up front with `app_not_responding`; controls with no usable
pattern fail with `unsupported_control` and nothing is done.

**Known limits:** apps that don't expose UI Automation (many custom-drawn apps and games) can't be operated.
Windows may refuse to bring a window to the front. Each call has the 30-second timeout and Stop works, but a call
runs on its own thread, so a hung app only holds that thread; after 4 calls are stuck, new desktop calls are
refused until the app recovers. `app_type` reads the value back and reports `value_confirmed`.
Only one window's refs are kept at a time, shared across chats. Not yet covered by automated tests.

## Packaging

`npm install` (postinstall) copies the Node.js runtime it runs on into `src-tauri/resources/node.exe`
(git-ignored); `npm run tauri build` runs it again and bundles that runtime, `browser-worker/` and
`node_modules/playwright-core` as app resources (`bundle.resources` in `src-tauri/tauri.conf.json`).
The installed app finds the worker and `node.exe` next to its executable, so it needs neither the source
tree nor a global Node.js (release builds never fall back to the source tree; `AA_NODE_PATH` still overrides).
Edge (or Chrome via `AA_BROWSER_CHANNEL`) must be installed; otherwise browser calls fail with
`browser_unavailable` and the rest of the app works. The bundled layout was run standalone with the worker;
a full installer build hasn't been tested yet. The bundled runtime adds about 90 MB.

## Checks

```bash
npm run build                          # TypeScript type-check + production frontend build
cd src-tauri && cargo test             # Rust unit tests (SSE, history, errors, path guard, file tools)
npm run test:browser                   # browser worker vs controlled local pages (real Edge)
cd src-tauri && cargo test -- --ignored  # Rust → worker → browser end-to-end test
cd src-tauri && cargo clippy           # optional lint
```

Backend logs go to the terminal and to the app's log directory
(`%LOCALAPPDATA%\com.helper.app\logs`). Logs never include API keys or message content.

## Architecture

```
src/                       React frontend
  services/types.ts        Service contracts (chat, tasks, automations, agent, AI config)
  services/tauri/          Live chat + key management via Tauri commands
  services/mock/           Mock chat/tasks/automations (used when nothing is configured)
  store/AppStore.tsx       App state; picks live vs mock chat at runtime
src-tauri/src/
  commands.rs              chat, API key, tool-approval and allowed-folder commands
  config.rs                API key resolution (env → OS credential store)
  error.rs                 Typed errors: { kind, message, retryable, status }
  state.rs                 HTTP client + in-flight request registry for cancellation
  ai/agent.rs              Tool-calling loop (round → tools → results → round)
  ai/openai.rs             OpenAI Chat Completions streaming client, tool-call assembly, retries
  tools/                   Tool registry, path guard, file tools, allowed folders
  browser/                 Browser tools, URL policy, approval rules, worker lifecycle
  desktop/                 Windows desktop app tools (UI Automation), safety rules, approvals
browser-worker/            Playwright worker (Node) + network policy + tests
  ai/sse.rs                Incremental Server-Sent Events parser
  ai/history.rs            Conversation normalization (ordering, roles, size limit)
  ai/types.rs              Request/stream event types shared with the frontend
```

**How a message flows:** the frontend sends the ordered history to `chat_stream`.
It passes a Tauri `Channel`, and the backend streams `start` → `delta`… → `done`
events over it. **Stop** calls `chat_cancel`, which aborts the HTTP stream.
Transient failures (429, 5xx, network) are retried automatically up to twice
before any text arrives. After that, the error is shown with **Try again**.
Error kinds about the key or model also offer **Open settings**.

**Tool calling:** `ai/agent.rs` runs the loop:

1. Stream a completion.
2. Run any tools the model requests. Consecutive auto-allowed read-only calls run concurrently; writes run one at a time, in the order requested.
3. Send the results back as `role: "tool"` messages.
4. Repeat until the model answers, up to “Max steps per task”.

`tools/` holds the registry (`mod.rs`), path confinement (`paths.rs`), the four tools (`fs.rs`) and the allowed-folder store (`allowed_dirs.rs`). Tool events (`tool_call`, `tool_status`) stream over the same Tauri channel and drive the existing task UI.

**Follow-ups:** each assistant reply sent back as history carries a compact tool record
(tool, arguments, status, clipped output or error), labeled as data, so follow-up questions can use
real results. Raw tool messages themselves aren't replayed. The model decides
whether to request several tools at once; independent reads run concurrently when it does.
