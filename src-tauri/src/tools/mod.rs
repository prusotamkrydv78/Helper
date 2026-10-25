//! Tool registry and dispatcher. Only tools listed in `TOOLS` can run; each maps
//! to a Rust function with typed, strictly validated arguments.

pub mod allowed_dirs;
pub mod fs;
pub mod paths;

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
pub struct ToolOutput {
    pub content: Value,
    pub summary: String,
    pub file: Option<FileChange>,
}

#[derive(Debug, Clone)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn invalid(m: impl Into<String>) -> Self {
        Self { code: "invalid_arguments", message: m.into() }
    }
    pub fn denied(m: impl Into<String>) -> Self {
        Self { code: "permission_denied", message: m.into() }
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self { code: "not_found", message: m.into() }
    }
    pub fn io(path: &Path, e: &std::io::Error) -> Self {
        Self { code: "io_error", message: format!("{}: {e}", paths::display(path)) }
    }
    pub fn timeout() -> Self {
        Self { code: "timeout", message: format!("The tool did not finish within {}s.", TOOL_TIMEOUT.as_secs()) }
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
