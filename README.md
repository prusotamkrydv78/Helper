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
  re-resolve to a private address (DNS rebinding). Service workers are blocked and WebRTC is kept off local addresses.
- **Approvals** come from inspecting the real element, not from the model's description. For example, clicking a button that submits a form asks “Submits a form (“Send”) to https://…”.
- **File uploads** aren't supported. Downloads go only into allowed folders, file names are sanitized, and the saved path is checked again afterwards.
- **Untrusted content:** page text, links and search results reach the model labeled as untrusted data, and the system prompt tells it never to follow instructions found on pages.
- **Session lifecycle:** one session; per-action timeouts (25–120 s). **Stop**, or a timeout, closes the browser session (the next call starts a fresh one). The session also closes after 5 idle minutes and when the app exits.

**Tested live** (through the app with a real model): searching the public web, opening a real page and reading it;
filling and submitting a form on a controlled test page, with the approval prompt; and a
prompt-injection page, whose planted instructions were ignored. Downloads, the address
blocking and redirects are covered by the automated tests against local pages. A live
download from a public site hasn't been tested.

## Desktop app tools (Windows)

The assistant can read and operate other apps' windows through Windows UI Automation
(`src-tauri/src/desktop/`). It uses accessibility patterns (Invoke, Toggle, Select, Expand, Value),
never synthetic mouse or keyboard input or screenshots.

| Tool | What it does | Approval |
| --- | --- | --- |
| `app_list_windows` | Visible top-level windows: handle, title, executable | none |
| `app_get_ui_tree` | A window's named elements (max 300), each with a ref like `e3_12` | none |
| `app_focus` | Brings a window to the front | when “Desktop apps” = Ask |
| `app_launch` | Starts an app from Settings → Allowed apps, without arguments or a shell | always |
| `app_click` | Invokes/toggles/selects/expands an element by ref | always |
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

**Known limits:** apps that don't expose UI Automation (many custom-drawn apps and games) can't be operated.
Windows may refuse to bring a window to the front. Each call has the 30-second timeout and Stop works, but a call
stuck inside a hung app keeps its background thread until the app responds (later calls use other threads).
Only one window's refs are kept at a time, shared across chats. Not yet covered by automated tests.

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

**Known limits:** tool-call turns aren't saved in chat history, so follow-up
messages see the final answer but not the raw tool results. The model decides
whether to request several tools at once; independent reads run concurrently when it does.
