//! File management beyond read/write: search, batch move/rename (with a preview
//! shown in the approval prompt), and duplicate detection. Every path goes
//! through `PathGuard`, so all of this stays inside the permitted folders.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::paths::{display, PathGuard};
use super::{FileChange, ToolError, ToolOutput};

const MAX_RESULTS: usize = 200;
const MAX_SCANNED: usize = 20_000;
const MAX_DEPTH: usize = 8;
const MAX_MOVES: usize = 100;
/// Files larger than this are compared by size + first/last MiB only.
const FULL_HASH_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    pub path: String,
    /// Case-insensitive name match; `*` wildcards allowed (e.g. "*.pdf", "report*2026*").
    pub pattern: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Move {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveArgs {
    pub moves: Vec<Move>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicateArgs {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

/// `*` wildcard match on lowercase strings.
fn wildcard(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return name.contains(pattern);
    }
    let mut rest = name;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            match rest.find(part) {
                Some(p) => rest = &rest[p + part.len()..],
                None => return false,
            }
        }
    }
    true
}

/// Regular files under `root` (symlinks are not followed), up to the scan limit.
fn files_under(root: &Path, recursive: bool, truncated: &mut bool) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if out.len() >= MAX_SCANNED {
                *truncated = true;
                return out;
            }
            let Ok(meta) = e.path().symlink_metadata() else { continue };
            if meta.is_dir() {
                if recursive && depth + 1 < MAX_DEPTH {
                    stack.push((e.path(), depth + 1));
                }
            } else if meta.is_file() {
                out.push((e.path(), meta.len()));
            }
        }
    }
    out
}

pub fn search_files(guard: &PathGuard, args: SearchArgs) -> Result<ToolOutput, ToolError> {
    let root = guard.existing(&args.path)?;
    if !root.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&root))));
    }
    let pattern = args.pattern.trim().to_lowercase();
    if pattern.is_empty() {
        return Err(ToolError::invalid("`pattern` must not be empty."));
    }
    let mut truncated = false;
    let mut hits: Vec<Value> = Vec::new();
    for (p, size) in files_under(&root, args.recursive, &mut truncated) {
        let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if wildcard(&pattern, &name) {
            if hits.len() >= MAX_RESULTS {
                truncated = true;
                break;
            }
            hits.push(json!({ "path": display(&p), "size": size }));
        }
    }
    let n = hits.len();
    Ok(ToolOutput {
        content: json!({ "matches": hits, "truncated": truncated }),
        summary: format!("{n} matching files{}", if truncated { " (truncated)" } else { "" }),
        file: None,
    })
}

/// Resolves and validates a batch of moves without changing anything.
fn plan_moves(guard: &PathGuard, args: &MoveArgs) -> Result<Vec<(PathBuf, PathBuf)>, ToolError> {
    if args.moves.is_empty() || args.moves.len() > MAX_MOVES {
        return Err(ToolError::invalid(format!("Give between 1 and {MAX_MOVES} moves.")));
    }
    let mut plan = Vec::new();
    for m in &args.moves {
        let from = guard.existing(&m.from)?;
        if guard.root_list().contains(&display(&from)) {
            return Err(ToolError::denied("A permitted folder itself can't be moved."));
        }
        let to = guard.creatable(&m.to)?;
        if to.starts_with(&from) {
            return Err(ToolError::invalid(format!("Can't move {} into itself.", display(&from))));
        }
        if to.exists() && !args.overwrite {
            return Err(ToolError::new("already_exists", format!("{} already exists. Set `overwrite` to replace it.", display(&to))));
        }
        if to.is_dir() {
            return Err(ToolError::invalid(format!("{} is a folder; give the full destination path.", display(&to))));
        }
        if !to.parent().is_some_and(Path::is_dir) {
            return Err(ToolError::not_found(format!("The destination folder for {} doesn't exist.", display(&to))));
        }
        plan.push((from, to));
    }
    Ok(plan)
}

/// The approval text: every move, so the user sees the full change before it happens.
pub fn move_preview(guard: &PathGuard, args: &Value) -> Result<String, ToolError> {
    let a: MoveArgs = super::parse(args)?;
    let plan = plan_moves(guard, &a)?;
    let mut s = format!("Move/rename {} item(s){}:", plan.len(), if a.overwrite { ", replacing existing files" } else { "" });
    for (from, to) in plan.iter().take(20) {
        s.push_str(&format!("\n• {} → {}", display(from), display(to)));
    }
    if plan.len() > 20 {
        s.push_str(&format!("\n• … and {} more", plan.len() - 20));
    }
    Ok(s)
}

pub fn move_files(guard: &PathGuard, args: MoveArgs) -> Result<ToolOutput, ToolError> {
    let plan = plan_moves(guard, &args)?;
    let mut results = Vec::new();
    let mut moved = 0;
    for (from, to) in &plan {
        // Re-check at execution time: the folder may have changed since the preview.
        let r = if to.exists() && !args.overwrite {
            Err("destination exists".to_owned())
        } else {
            fs::rename(from, to).map_err(|e| {
                if e.raw_os_error() == Some(17) {
                    "different drive; moving across drives isn't supported".to_owned()
                } else {
                    e.to_string()
                }
            })
        };
        // Verify the outcome on disk rather than trusting the call.
        let ok = r.is_ok() && to.exists() && !from.exists();
        if ok {
            moved += 1;
        }
        results.push(json!({ "from": display(from), "to": display(to), "ok": ok, "error": r.err() }));
    }
    let last = plan.last().map(|(_, to)| display(to));
    Ok(ToolOutput {
        content: json!({ "results": results, "moved": moved, "failed": plan.len() - moved }),
        summary: format!("Moved {moved} of {}", plan.len()),
        file: last.filter(|_| moved > 0).map(|path| FileChange { path, kind: "moved" }),
    })
}

fn hash_file(p: &Path, size: u64) -> Option<String> {
    let mut f = fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    if size <= FULL_HASH_LIMIT {
        loop {
            let n = f.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
    } else {
        use std::io::{Seek, SeekFrom};
        let n = f.read(&mut buf).ok()?;
        h.update(&buf[..n]);
        f.seek(SeekFrom::End(-(buf.len() as i64))).ok()?;
        let n = f.read(&mut buf).ok()?;
        h.update(&buf[..n]);
    }
    Some(format!("{:x}", h.finalize()))
}

pub fn find_duplicates(guard: &PathGuard, args: DuplicateArgs) -> Result<ToolOutput, ToolError> {
    let root = guard.existing(&args.path)?;
    if !root.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&root))));
    }
    let mut truncated = false;
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for (p, size) in files_under(&root, args.recursive, &mut truncated) {
        if size > 0 {
            by_size.entry(size).or_default().push(p);
        }
    }
    let mut groups: Vec<Value> = Vec::new();
    let mut wasted: u64 = 0;
    for (size, paths) in by_size.into_iter().filter(|(_, v)| v.len() > 1) {
        let mut by_hash: HashMap<String, Vec<PathBuf>> = HashMap::new();
        for p in paths {
            if let Some(h) = hash_file(&p, size) {
                by_hash.entry(h).or_default().push(p);
            }
        }
        for (_, same) in by_hash.into_iter().filter(|(_, v)| v.len() > 1) {
            wasted += size * (same.len() as u64 - 1);
            if groups.len() < MAX_RESULTS {
                groups.push(json!({ "size": size, "files": same.iter().map(|p| display(p)).collect::<Vec<_>>() }));
            } else {
                truncated = true;
            }
        }
    }
    let n = groups.len();
    Ok(ToolOutput {
        content: json!({
            "duplicate_groups": groups,
            "reclaimable_bytes": wasted,
            "truncated": truncated,
            "note": "Identical content (SHA-256; files over 256 MB compared by size and first/last MiB). Nothing was changed.",
        }),
        summary: format!("{n} groups of duplicates"),
        file: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(name: &str) -> (PathGuard, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ai-automation-ops-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        (PathGuard::new(&[dir.clone()]), dir)
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard("*.pdf", "report.pdf"));
        assert!(wildcard("report*2026*", "report-q1-2026.xlsx"));
        assert!(!wildcard("*.pdf", "report.pdf.txt"));
        assert!(wildcard("inv", "invoice.txt"));
    }

    #[test]
    fn moves_are_previewed_verified_and_confined() {
        let (g, dir) = guard("move");
        fs::write(dir.join("a.txt"), "x").unwrap();
        let args = json!({ "moves": [{ "from": "a.txt", "to": "sub/b.txt" }] });
        assert!(move_preview(&g, &args).unwrap().contains("b.txt"));
        let out = move_files(&g, serde_json::from_value(args).unwrap()).unwrap();
        assert_eq!(out.content["moved"], 1);
        assert!(dir.join("sub/b.txt").exists());
        let escape = json!({ "moves": [{ "from": "sub/b.txt", "to": "../escape.txt" }] });
        assert!(move_preview(&g, &escape).is_err());
    }

    #[test]
    fn finds_duplicates_by_content() {
        let (g, dir) = guard("dups");
        fs::write(dir.join("one.txt"), "same").unwrap();
        fs::write(dir.join("sub/two.txt"), "same").unwrap();
        fs::write(dir.join("other.txt"), "diff").unwrap();
        let out = find_duplicates(&g, DuplicateArgs { path: display(&dir), recursive: true }).unwrap();
        assert_eq!(out.content["duplicate_groups"].as_array().unwrap().len(), 1);
    }
}
