//! Tool registry and dispatcher. Only tools listed in `TOOLS` can run; each maps
//! to a Rust function with typed, strictly validated arguments.

pub mod allowed_dirs;
pub mod fs;
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

fn parse<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, ToolError> {
    serde_json::from_value(args.clone()).map_err(|e| ToolError::invalid(format!("Invalid arguments: {e}")))
}

/// Runs a tool synchronously. Callers run this on a blocking thread with a timeout.
pub fn execute(spec: &ToolSpec, args: &Value, guard: &PathGuard) -> Result<ToolOutput, ToolError> {
    match spec.name {
        "list_files" => fs::list_files(guard, parse(args)?),
        "read_file" => fs::read_file(guard, parse(args)?),
        "create_directory" => fs::create_directory(guard, parse(args)?),
        "write_file" => fs::write_file(guard, parse(args)?),
        other => Err(ToolError::invalid(format!("Unknown tool `{other}`."))),
    }
}
