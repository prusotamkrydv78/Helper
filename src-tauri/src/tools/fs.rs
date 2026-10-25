//! The four file tools. All paths go through `PathGuard`; these functions are
//! blocking and are run on a worker thread by the dispatcher.

use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use super::paths::{display, PathGuard};
use super::{FileChange, ToolError, ToolOutput};

const MAX_LIST_ENTRIES: usize = 500;
const MAX_LIST_DEPTH: usize = 3;
const MAX_READ_BYTES: usize = 200_000;
const MAX_WRITE_BYTES: usize = 1_000_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathArgs {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteArgs {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub overwrite: bool,
}

pub fn list_files(guard: &PathGuard, args: ListArgs) -> Result<ToolOutput, ToolError> {
    let root = guard.existing(&args.path)?;
    if !root.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&root))));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    walk(&root, &root, 0, if args.recursive { MAX_LIST_DEPTH } else { 1 }, &mut entries, &mut truncated)?;
    let count = entries.len();
    Ok(ToolOutput {
        content: json!({ "path": display(&root), "entries": entries, "truncated": truncated }),
        summary: format!("{count} entries{}", if truncated { " (truncated)" } else { "" }),
        file: None,
    })
}

fn walk(
    base: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<Value>,
    truncated: &mut bool,
) -> Result<(), ToolError> {
    let mut items: Vec<_> = fs::read_dir(dir)
        .map_err(|e| ToolError::io(dir, &e))?
        .filter_map(Result::ok)
        .collect();
    items.sort_by_key(|e| e.file_name());
    for item in items {
        if out.len() >= MAX_LIST_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        // symlink_metadata: never follow links out of the permitted folder.
        let Ok(meta) = item.path().symlink_metadata() else { continue };
        let rel = item.path().strip_prefix(base).map(display).unwrap_or_default();
        let kind = if meta.is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "directory"
        } else {
            "file"
        };
        out.push(json!({ "path": rel, "type": kind, "size": meta.is_file().then_some(meta.len()) }));
        if meta.is_dir() && depth + 1 < max_depth {
            walk(base, &item.path(), depth + 1, max_depth, out, truncated)?;
        }
    }
    Ok(())
}

pub fn read_file(guard: &PathGuard, args: PathArgs) -> Result<ToolOutput, ToolError> {
    let path = guard.existing(&args.path)?;
    if !path.is_file() {
        return Err(ToolError::invalid(format!("{} is not a file.", display(&path))));
    }
    let bytes = fs::read(&path).map_err(|e| ToolError::io(&path, &e))?;
    let truncated = bytes.len() > MAX_READ_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    if slice.contains(&0) {
        return Err(ToolError::invalid(format!("{} looks like a binary file.", display(&path))));
    }
    // Lossy only at a cut point; otherwise require valid UTF-8.
    let text = match std::str::from_utf8(slice) {
        Ok(t) => t.to_owned(),
        Err(e) if truncated && e.valid_up_to() + 4 >= slice.len() => {
            String::from_utf8_lossy(&slice[..e.valid_up_to()]).into_owned()
        }
        Err(_) => return Err(ToolError::invalid(format!("{} is not a UTF-8 text file.", display(&path)))),
    };
    Ok(ToolOutput {
        summary: format!("{} bytes{}", bytes.len(), if truncated { ", first 200 KB" } else { "" }),
        content: json!({ "path": display(&path), "size": bytes.len(), "truncated": truncated, "content": text }),
        file: None,
    })
}

pub fn create_directory(guard: &PathGuard, args: PathArgs) -> Result<ToolOutput, ToolError> {
    let path = guard.creatable(&args.path)?;
    if path.exists() {
        if path.is_dir() {
            return Ok(ToolOutput {
                content: json!({ "path": display(&path), "created": false, "note": "Directory already exists." }),
                summary: "Already existed".into(),
                file: None,
            });
        }
        return Err(ToolError::invalid(format!("{} exists and is a file.", display(&path))));
    }
    fs::create_dir_all(&path).map_err(|e| ToolError::io(&path, &e))?;
    Ok(ToolOutput {
        content: json!({ "path": display(&path), "created": true }),
        summary: "Created".into(),
        file: Some(FileChange { path: display(&path), kind: "created" }),
    })
}

pub fn write_file(guard: &PathGuard, args: WriteArgs) -> Result<ToolOutput, ToolError> {
    if args.content.len() > MAX_WRITE_BYTES {
        return Err(ToolError::invalid("Content is larger than the 1 MB limit."));
    }
    let path = guard.creatable(&args.path)?;
    let existed = path.exists();
    if existed && !path.is_file() {
        return Err(ToolError::invalid(format!("{} is not a regular file.", display(&path))));
    }
    if existed && !args.overwrite {
        return Err(ToolError::invalid(format!(
            "{} already exists. Set `overwrite` to true to replace it.",
            display(&path)
        )));
    }
    match path.parent() {
        Some(parent) if parent.is_dir() => {}
        _ => {
            return Err(ToolError::not_found(
                "The parent directory doesn't exist. Create it first with create_directory.",
            ))
        }
    }
    fs::write(&path, args.content.as_bytes()).map_err(|e| ToolError::io(&path, &e))?;
    let kind = if existed { "modified" } else { "created" };
    Ok(ToolOutput {
        content: json!({ "path": display(&path), "bytes": args.content.len(), "result": kind }),
        summary: format!("{} · {} bytes", if existed { "Updated" } else { "Created" }, args.content.len()),
        file: Some(FileChange { path: display(&path), kind }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(name: &str) -> (PathGuard, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("ai-automation-fs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (PathGuard::new(&[dir.clone()]), dir)
    }

    #[test]
    fn write_read_list_roundtrip() {
        let (g, dir) = guard("roundtrip");
        create_directory(&g, PathArgs { path: "notes".into() }).unwrap();
        let w = write_file(&g, WriteArgs { path: "notes/a.txt".into(), content: "hello".into(), overwrite: false }).unwrap();
        assert_eq!(w.file.unwrap().kind, "created");
        let r = read_file(&g, PathArgs { path: "notes/a.txt".into() }).unwrap();
        assert_eq!(r.content["content"], "hello");
        let l = list_files(&g, ListArgs { path: dir.display().to_string(), recursive: true }).unwrap();
        assert_eq!(l.content["entries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn write_refuses_overwrite_without_flag_and_missing_parent() {
        let (g, _) = guard("overwrite");
        write_file(&g, WriteArgs { path: "a.txt".into(), content: "1".into(), overwrite: false }).unwrap();
        assert!(write_file(&g, WriteArgs { path: "a.txt".into(), content: "2".into(), overwrite: false }).is_err());
        let w = write_file(&g, WriteArgs { path: "a.txt".into(), content: "2".into(), overwrite: true }).unwrap();
        assert_eq!(w.file.unwrap().kind, "modified");
        assert!(write_file(&g, WriteArgs { path: "missing/b.txt".into(), content: "x".into(), overwrite: false }).is_err());
    }

    #[test]
    fn read_rejects_binary() {
        let (g, dir) = guard("binary");
        fs::write(dir.join("b.bin"), [0u8, 1, 2]).unwrap();
        assert!(read_file(&g, PathArgs { path: "b.bin".into() }).is_err());
    }
}
