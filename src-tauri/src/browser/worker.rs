//! Lifecycle of the Node/Playwright browser worker process.
//!
//! - Started lazily on the first browser tool call; one managed session.
//! - One call at a time (the browser is stateful); every call has a timeout.
//! - Cancellation or a timeout kills the process, ending the session cleanly;
//!   the next call starts a fresh one.
//! - Shut down after `IDLE_SHUTDOWN` without use, and when the app exits
//!   (`kill_on_drop`).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::tools::ToolError;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
pub const IDLE_SHUTDOWN: Duration = Duration::from_secs(5 * 60);

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

pub struct BrowserWorker {
    node: String,
    script: Option<PathBuf>,
    proc: Mutex<Option<Proc>>,
    last_used: StdMutex<Instant>,
    /// Folder for a persistent browser profile (logins kept); None = clean sessions.
    profile: StdMutex<Option<std::path::PathBuf>>,
}

fn locate_script() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AA_BROWSER_WORKER") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    // Installed app: bundled next to the executable (tauri.conf.json `bundle.resources`).
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
        let bundled = dir.join("browser-worker").join("worker.mjs");
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    // Development: the source tree. Release builds never fall back to it.
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../browser-worker/worker.mjs"));
        return dev.is_file().then_some(dev);
    }
    None
}

/// Node runtime: `AA_NODE_PATH`, else the one bundled beside the worker script, else `node` on PATH.
fn locate_node(script: Option<&std::path::Path>) -> String {
    if let Ok(p) = std::env::var("AA_NODE_PATH") {
        return p;
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    script
        .and_then(|s| s.parent())
        .map(|d| d.join(exe))
        .filter(|p| p.is_file())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "node".into())
}

impl BrowserWorker {
    pub fn new() -> Self {
        let script = locate_script();
        match &script {
            Some(s) => log::info!("browser worker script: {}", s.display()),
            None => log::warn!("browser worker script not found; browser tools disabled"),
        }
        Self {
            node: locate_node(script.as_deref()),
            script,
            proc: Mutex::new(None),
            last_used: StdMutex::new(Instant::now()),
            profile: StdMutex::new(None),
        }
    }

    /// Uses (or stops using) a persistent profile. Takes effect with the next session, so the
    /// current one is closed.
    pub async fn set_profile(&self, dir: Option<std::path::PathBuf>) {
        *self.profile.lock().unwrap_or_else(|e| e.into_inner()) = dir;
        self.shutdown().await;
    }

    /// Closes the browser session now (used by Stop all and profile changes).
    pub async fn shutdown(&self) -> bool {
        let mut guard = match tokio::time::timeout(Duration::from_secs(3), self.proc.lock()).await {
            Ok(g) => g,
            // A call holds the lock; Stop already cancelled it, the call restarts the worker itself.
            Err(_) => return false,
        };
        if let Some(mut p) = guard.take() {
            drop(p.stdin);
            let _ = tokio::time::timeout(Duration::from_secs(3), p.child.wait()).await;
            let _ = p.child.start_kill();
        }
        true
    }

    /// What diagnostics can say without starting anything.
    pub fn diagnostics(&self) -> serde_json::Value {
        let node_found = std::path::Path::new(&self.node).is_file();
        serde_json::json!({
            "script": self.script.as_ref().map(|s| s.display().to_string()),
            "node": self.node,
            "nodeFound": node_found,
            "profile": self.profile.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|p| p.display().to_string()),
        })
    }

    /// Whether browser tools can be offered at all.
    pub fn available(&self) -> bool {
        self.script.is_some()
    }

    async fn spawn(&self) -> Result<Proc, ToolError> {
        let script = self.script.as_ref().ok_or_else(|| ToolError::new("browser_unavailable", "The browser worker isn't installed."))?;
        let mut cmd = Command::new(&self.node);
        cmd.arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = self.profile.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            cmd.env("AA_BROWSER_PROFILE", dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
        let mut child = cmd.spawn().map_err(|e| {
            ToolError::new("browser_unavailable", format!("Couldn't start Node.js ({}): {e}. Install Node.js 20+.", self.node))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| ToolError::new("browser_unavailable", "No stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| ToolError::new("browser_unavailable", "No stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("{line}");
                }
            });
        }
        let mut stdout = BufReader::new(stdout).lines();
        // Wait for the ready message: {"id":0,"ok":true,...}
        let ready = tokio::time::timeout(STARTUP_TIMEOUT, stdout.next_line()).await;
        match ready {
            Ok(Ok(Some(line))) if line.contains("\"ready\":true") => {}
            _ => {
                return Err(ToolError::new("browser_unavailable", "The browser worker didn't start. Check that playwright-core is installed (npm install)."))
            }
        }
        log::info!("browser worker started");
        Ok(Proc { child, stdin, stdout, next_id: 1 })
    }

    /// Sends one command and waits for its result.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, ToolError> {
        let mut guard = self.proc.lock().await;
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        if guard.as_mut().is_some_and(|p| p.child.try_wait().ok().flatten().is_some()) {
            log::warn!("browser worker had exited; restarting");
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(self.spawn().await?);
        }
        let proc = guard.as_mut().expect("worker present");
        let id = proc.next_id;
        proc.next_id += 1;

        let exchange = async {
            let line = json!({ "id": id, "method": method, "params": params }).to_string() + "\n";
            proc.stdin.write_all(line.as_bytes()).await.map_err(|e| ToolError::new("browser_error", format!("Worker write failed: {e}")))?;
            proc.stdin.flush().await.ok();
            loop {
                let line = proc
                    .stdout
                    .next_line()
                    .await
                    .map_err(|e| ToolError::new("browser_error", format!("Worker read failed: {e}")))?
                    .ok_or_else(|| ToolError::new("browser_error", "The browser worker stopped unexpectedly."))?;
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if msg["id"].as_u64() != Some(id) {
                    continue; // stale response from a cancelled call
                }
                return if msg["ok"].as_bool() == Some(true) {
                    Ok(msg["result"].clone())
                } else {
                    let code = msg["error"]["code"].as_str().unwrap_or("browser_error").to_owned();
                    let message = msg["error"]["message"].as_str().unwrap_or("Browser action failed.").to_owned();
                    Err(ToolError::new(code, message))
                };
            }
        };

        let outcome = tokio::select! {
            _ = cancel.cancelled() => Err(None),
            r = tokio::time::timeout(timeout, exchange) => match r {
                Ok(res) => Ok(res),
                Err(_) => Err(Some(timeout)),
            },
        };
        match outcome {
            Ok(res) => res,
            Err(reason) => {
                // The worker may be mid-action; end the session rather than leave it in an unknown state.
                if let Some(mut p) = guard.take() {
                    let _ = p.child.start_kill();
                }
                match reason {
                    None => {
                        log::info!("browser call {method} cancelled; session closed");
                        Err(ToolError::new("cancelled", "Cancelled."))
                    }
                    Some(t) => {
                        log::warn!("browser call {method} timed out after {t:?}; session closed");
                        Err(ToolError::new("timeout", format!("The browser didn't respond within {}s; the session was restarted.", t.as_secs())))
                    }
                }
            }
        }
    }

    /// Stops the worker if it has been idle for `IDLE_SHUTDOWN`.
    pub async fn shutdown_if_idle(&self) {
        let idle = self.last_used.lock().unwrap_or_else(|e| e.into_inner()).elapsed();
        if idle < IDLE_SHUTDOWN {
            return;
        }
        if let Ok(mut guard) = self.proc.try_lock() {
            if let Some(mut p) = guard.take() {
                log::info!("browser worker idle for {idle:?}; shutting down");
                drop(p.stdin); // worker exits when stdin closes
                let _ = tokio::time::timeout(Duration::from_secs(5), p.child.wait()).await;
                let _ = p.child.start_kill();
            }
        }
    }
}
