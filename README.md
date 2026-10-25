# AI Automation

A desktop AI assistant built with Tauri 2, Rust, React 19, TypeScript and Vite.

**Current status:** chat is live through OpenAI when an API key is configured.
Tasks, automations and the local PC agent are still simulated. The app does not
run commands or touch your files.

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

## Checks

```bash
npm run build                          # TypeScript type-check + production frontend build
cd src-tauri && cargo test             # Rust unit tests (SSE parser, history, error mapping)
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
  commands.rs              chat_stream, chat_cancel, ai_status, set_api_key, clear_api_key
  config.rs                API key resolution (env → OS credential store)
  error.rs                 Typed errors: { kind, message, retryable, status }
  state.rs                 HTTP client + in-flight request registry for cancellation
  ai/openai.rs             OpenAI Chat Completions streaming client, retries, error mapping
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

**Next phase:** tool calling will add tool definitions to the request in
`ai/openai.rs` and new `StreamEvent` variants for tool calls. Those events will
drive the existing task UI. Real PC actions will need a permission-controlled
local executor, which hasn't been built yet.
