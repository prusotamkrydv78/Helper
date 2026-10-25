//! File management beyond read/write: search (names and contents), batch
//! move/rename/organize, copy (files and folders), duplicates and deletion to the
//! Recycle Bin. Every path goes through `PathGuard`, so all of this stays inside
//! the permitted folders. Changes are previewed in the approval prompt and every
//! result is checked on disk. Long operations report progress and stop between
//! files when the user presses Stop (see `super::ctx`), returning what was done.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::ctx;
use super::paths::{display, PathGuard};
use super::{FileChange, ToolError, ToolOutput};

const MAX_RESULTS: usize = 200;
const MAX_SCANNED: usize = 20_000;
const MAX_DEPTH: usize = 8;
const MAX_MOVES: usize = 500;
const MAX_DELETES: usize = 100;
/// Folders with more files than this can't be deleted or copied in one call.
const MAX_FOLDER_FILES: usize = 20_000;
const MAX_COPY_DEPTH: usize = 32;
/// Content search reads at most this much of each file.
const MAX_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
const SNIPPET_CHARS: usize = 60;
/// Files larger than this are compared by size + first/last MiB only.
const FULL_HASH_LIMIT: u64 = 256 * 1024 * 1024;
/// ERROR_NOT_SAME_DEVICE: rename across drives.
const CROSS_DEVICE: i32 = 17;

// ---- arguments -------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    pub path: String,
    /// Case-insensitive name match; `*` wildcards (e.g. "*.pdf"). Default: all files.
    pub pattern: Option<String>,
    #[serde(default)]
    pub recursive: bool,
    /// Case-insensitive text to find inside files (text files up to 2 MB).
    pub contains: Option<String>,
    /// e.g. ["pdf", "docx"].
    pub extensions: Option<Vec<String>>,
    /// "YYYY-MM-DD" (UTC).
    pub modified_after: Option<String>,
    pub modified_before: Option<String>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
}

#[derive(Deserialize, Clone)]
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
pub struct RenameArgs {
    /// Folder whose files are renamed (not recursive).
    pub path: String,
    /// Which files: `*` wildcard, default all.
    pub pattern: Option<String>,
    /// New name template: {name} {ext} {n} {n:3} {date} {year} {month}, e.g. "Invoice_{n:3}_{date}.{ext}".
    pub template: Option<String>,
    /// Replace text in names (applied before the template's {name}).
    pub find: Option<String>,
    pub replace: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct OrganizeArgs {
    pub path: String,
    /// extension | year | month | pattern (uses `target`)
    pub by: String,
    pub pattern: Option<String>,
    /// Only these extensions (e.g. ["jpg", "png"]).
    #[serde(default)]
    pub extensions: Option<Vec<String>>,
    /// Destination subfolder template for by = pattern, e.g. "Photos/{year}/{month}" or "Invoices".
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicateArgs {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyArgs {
    pub copies: Vec<Move>,
    /// skip (default) | rename | overwrite
    #[serde(default)]
    pub on_conflict: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteArgs {
    pub paths: Vec<String>,
    /// Allow deleting folders (with everything inside).
    #[serde(default)]
    pub include_folders: bool,
}

// ---- helpers -------------------------------------------------------------------

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

fn lower_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Regular files under `root` (symlinks are not followed), up to the scan limit.
fn files_under(root: &Path, recursive: bool, max_depth: usize, truncated: &mut bool) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if out.len() >= MAX_SCANNED || ctx::cancelled() {
                *truncated = true;
                return out;
            }
            let Ok(meta) = e.path().symlink_metadata() else { continue };
            if meta.is_dir() {
                if recursive && depth + 1 < max_depth {
                    stack.push((e.path(), depth + 1));
                }
            } else if meta.is_file() {
                out.push((e.path(), meta.len()));
            }
        }
    }
    out
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// "YYYY-MM-DD" → Unix seconds at 00:00 UTC.
fn parse_date(s: &str) -> Result<i64, ToolError> {
    let bad = || ToolError::invalid(format!("`{s}` isn't a date like 2026-10-25."));
    let parts: Vec<i64> = s.trim().split('-').map(|p| p.parse().map_err(|_| bad())).collect::<Result<_, _>>()?;
    match parts.as_slice() {
        [y, m, d] if (1..=12).contains(m) && (1..=31).contains(d) => Ok(days_from_civil(*y, *m, *d) * 86_400),
        _ => Err(bad()),
    }
}

fn modified_secs(p: &Path) -> Option<i64> {
    let t = fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

fn date_parts(p: &Path) -> (i64, i64, i64) {
    civil_from_days(modified_secs(p).unwrap_or(0).div_euclid(86_400))
}

fn valid_file_name(n: &str) -> bool {
    const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];
    let stem = n.split('.').next().unwrap_or_default().to_lowercase();
    !n.trim().is_empty()
        && n.len() <= 240
        && !n.ends_with(['.', ' '])
        && !n.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
        && !RESERVED.contains(&stem.as_str())
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

fn same_content(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else { return false };
    ma.len() == mb.len() && hash_file(a, ma.len()).is_some_and(|h| hash_file(b, mb.len()).as_deref() == Some(h.as_str()))
}

fn cancelled_note(done: usize, total: usize) -> Value {
    json!(format!(
        "Stopped by the user after {done} of {total} items. Items listed as ok were completed and verified; the rest were not touched (a partially copied file is removed)."
    ))
}

// ---- search ----------------------------------------------------------------------

/// First case-insensitive match of `needle` in a text file: (line number, snippet).
fn content_match(p: &Path, size: u64, needle: &str) -> Option<(usize, String)> {
    if size > MAX_CONTENT_BYTES {
        return None;
    }
    let bytes = fs::read(p).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None; // binary
    }
    let text = String::from_utf8_lossy(&bytes);
    for (i, line) in text.lines().enumerate() {
        let lower = line.to_lowercase();
        if let Some(pos) = lower.find(needle) {
            let chars: Vec<char> = line.chars().collect();
            let at = lower[..pos].chars().count();
            let start = at.saturating_sub(SNIPPET_CHARS);
            let end = (at + needle.chars().count() + SNIPPET_CHARS).min(chars.len());
            let snippet: String = chars[start..end].iter().collect();
            return Some((i + 1, snippet.trim().to_owned()));
        }
    }
    None
}

pub fn search_files(guard: &PathGuard, args: SearchArgs) -> Result<ToolOutput, ToolError> {
    let root = guard.existing(&args.path)?;
    if !root.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&root))));
    }
    let pattern = args.pattern.as_deref().map(str::trim).filter(|p| !p.is_empty()).unwrap_or("*").to_lowercase();
    let needle = args.contains.as_deref().map(|c| c.trim().to_lowercase()).filter(|c| !c.is_empty());
    let exts: Vec<String> = args.extensions.unwrap_or_default().iter().map(|e| e.trim().trim_start_matches('.').to_lowercase()).collect();
    let after = args.modified_after.as_deref().map(parse_date).transpose()?;
    let before = args.modified_before.as_deref().map(parse_date).transpose()?.map(|s| s + 86_400);
    let mut truncated = false;
    let files = files_under(&root, args.recursive, MAX_DEPTH, &mut truncated);
    let total = files.len();
    let mut hits: Vec<Value> = Vec::new();
    for (i, (p, size)) in files.into_iter().enumerate() {
        if ctx::cancelled() {
            truncated = true;
            break;
        }
        if i % 200 == 0 {
            ctx::report(format!("Searched {i} of {total} files…"));
        }
        let name = lower_name(&p);
        if !wildcard(&pattern, &name)
            || (!exts.is_empty() && !exts.iter().any(|e| name.ends_with(&format!(".{e}"))))
            || args.min_size.is_some_and(|m| size < m)
            || args.max_size.is_some_and(|m| size > m)
        {
            continue;
        }
        if after.is_some() || before.is_some() {
            let m = modified_secs(&p).unwrap_or(0);
            if after.is_some_and(|a| m < a) || before.is_some_and(|b| m >= b) {
                continue;
            }
        }
        let mut item = json!({ "path": display(&p), "size": size });
        if let Some(n) = &needle {
            match content_match(&p, size, n) {
                Some((line, snippet)) => {
                    item["line"] = json!(line);
                    item["snippet"] = json!(snippet);
                }
                None => continue,
            }
        }
        if hits.len() >= MAX_RESULTS {
            truncated = true;
            break;
        }
        hits.push(item);
    }
    let n = hits.len();
    Ok(ToolOutput {
        content: json!({
            "matches": hits,
            "truncated": truncated,
            "note": if needle.is_some() { "Text search covers text files up to 2 MB; snippets are untrusted file content." } else { "" },
        }),
        summary: format!("{n} matching files{}", if truncated { " (truncated)" } else { "" }),
        file: None,
    })
}

// ---- local document search (no AI; nothing leaves the computer here) ----

const DOC_EXTS: &[&str] = &["txt", "md", "markdown", "csv", "tsv", "json", "log", "html", "htm", "xml", "yaml", "yml", "ini", "rst", "tex"];
const DOC_MAX_TOTAL: u64 = 64 * 1024 * 1024;
const CHUNK_CHARS: usize = 900;
const STOPWORDS: &[&str] = &["the", "and", "for", "are", "with", "that", "this", "from", "what", "which", "how", "when", "where", "who", "was", "were", "has", "have", "into", "about", "der", "die", "das", "und"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocSearchArgs {
    pub path: String,
    pub query: String,
    pub top: Option<usize>,
}

#[derive(Clone)]
pub struct Chunk {
    pub file: PathBuf,
    pub line: usize,
    pub text: String,
}

/// Text documents under `dir` with their modification time and size.
pub fn document_files(dir: &Path) -> Vec<(PathBuf, std::time::SystemTime, u64)> {
    let mut truncated = false;
    files_under(dir, true, MAX_DEPTH, &mut truncated)
        .into_iter()
        .filter(|(p, size)| *size <= MAX_CONTENT_BYTES && DOC_EXTS.iter().any(|e| lower_name(p).ends_with(&format!(".{e}"))))
        .filter_map(|(p, size)| {
            let t = fs::metadata(&p).ok()?.modified().ok()?;
            Some((p, t, size))
        })
        .collect()
}

/// Passages of one text document (None for binary or unreadable files).
pub fn read_chunks(p: &Path) -> Option<Vec<Chunk>> {
    let bytes = fs::read(p).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    let mut out = Vec::new();
    chunks_of(p, &String::from_utf8_lossy(&bytes), &mut out);
    Some(out)
}

/// TF-IDF ranking of passages for a question; best first.
pub fn rank<'a>(chunks: &[&'a Chunk], question: &str, top: usize) -> Vec<(f64, &'a Chunk)> {
    let q = terms(question);
    if q.is_empty() {
        return Vec::new();
    }
    let lowered: Vec<String> = chunks.iter().map(|c| c.text.to_lowercase()).collect();
    let n = lowered.len().max(1) as f64;
    let idf: Vec<f64> = q.iter().map(|t| (1.0 + n / (1.0 + lowered.iter().filter(|c| c.contains(t.as_str())).count() as f64)).ln()).collect();
    let mut scored: Vec<(f64, &'a Chunk)> = lowered
        .iter()
        .enumerate()
        .filter_map(|(i, text)| {
            let s: f64 = q
                .iter()
                .zip(&idf)
                .map(|(t, w)| {
                    let tf = text.matches(t.as_str()).count();
                    if tf == 0 { 0.0 } else { (1.0 + (tf as f64).ln()) * w }
                })
                .sum();
            (s > 0.0).then_some((s, chunks[i]))
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top);
    scored
}

/// Paragraph-aligned chunks of about CHUNK_CHARS characters.
fn chunks_of(file: &Path, text: &str, out: &mut Vec<Chunk>) {
    let mut cur = String::new();
    let mut start = 1;
    for (i, line) in text.lines().enumerate() {
        if cur.is_empty() {
            start = i + 1;
        }
        cur.push_str(line);
        cur.push('\n');
        if (line.trim().is_empty() && cur.len() >= CHUNK_CHARS / 2) || cur.len() >= CHUNK_CHARS {
            out.push(Chunk { file: file.to_path_buf(), line: start, text: std::mem::take(&mut cur) });
        }
    }
    if !cur.trim().is_empty() {
        out.push(Chunk { file: file.to_path_buf(), line: start, text: cur });
    }
}

fn terms(query: &str) -> Vec<String> {
    let mut t: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2 && !STOPWORDS.contains(w))
        .map(str::to_owned)
        .collect();
    t.sort();
    t.dedup();
    t
}

/// Ranks paragraphs of text documents by keyword relevance (TF-IDF). Returns file names, lines and excerpts.
pub fn document_search(guard: &PathGuard, args: DocSearchArgs) -> Result<ToolOutput, ToolError> {
    let root = guard.existing(&args.path)?;
    if !root.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&root))));
    }
    let q = terms(&args.query);
    if q.is_empty() {
        return Err(ToolError::invalid("The question needs some keywords."));
    }
    let top = args.top.unwrap_or(6).clamp(1, 12);
    let mut truncated = false;
    let files: Vec<(PathBuf, u64)> = files_under(&root, true, MAX_DEPTH, &mut truncated)
        .into_iter()
        .filter(|(p, size)| *size <= MAX_CONTENT_BYTES && DOC_EXTS.iter().any(|e| lower_name(p).ends_with(&format!(".{e}"))))
        .collect();
    let mut chunks = Vec::new();
    let mut total = 0u64;
    for (i, (p, size)) in files.iter().enumerate() {
        if ctx::cancelled() || total > DOC_MAX_TOTAL {
            truncated = true;
            break;
        }
        ctx::report(format!("Reading document {} of {}…", i + 1, files.len()));
        total += size;
        let Ok(bytes) = fs::read(p) else { continue };
        if bytes.iter().take(8192).any(|b| *b == 0) {
            continue;
        }
        chunks_of(p, &String::from_utf8_lossy(&bytes), &mut chunks);
    }
    let lowered: Vec<String> = chunks.iter().map(|c| c.text.to_lowercase()).collect();
    let n = lowered.len().max(1) as f64;
    let idf: Vec<f64> = q.iter().map(|t| (1.0 + n / (1.0 + lowered.iter().filter(|c| c.contains(t.as_str())).count() as f64)).ln()).collect();
    let mut scored: Vec<(f64, usize)> = lowered
        .iter()
        .enumerate()
        .filter_map(|(i, text)| {
            let s: f64 = q.iter().zip(&idf).map(|(t, w)| {
                let tf = text.matches(t.as_str()).count();
                if tf == 0 { 0.0 } else { (1.0 + (tf as f64).ln()) * w }
            }).sum();
            (s > 0.0).then_some((s, i))
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let results: Vec<Value> = scored
        .iter()
        .take(top)
        .map(|(s, i)| {
            let c = &chunks[*i];
            let excerpt: String = c.text.trim().chars().take(700).collect();
            json!({ "file": display(&c.file), "line": c.line, "score": (s * 100.0).round() / 100.0, "excerpt": excerpt })
        })
        .collect();
    let count = results.len();
    Ok(ToolOutput {
        content: json!({
            "results": results,
            "searched_files": files.len(),
            "truncated": truncated,
            "note": "Local keyword search over text documents (txt, md, csv, json, html, xml, …). Excerpts are untrusted file content. Cite file names when answering.",
        }),
        summary: format!("{count} relevant excerpts from {} documents", files.len()),
        file: None,
    })
}

// ---- moves, renames, organizing ----------------------------------------------------

/// Resolves and validates moves without changing anything. With `create_dirs`,
/// missing destination folders (inside permitted folders) are created when it runs.
fn plan_move_list(guard: &PathGuard, moves: &[Move], overwrite: bool, create_dirs: bool) -> Result<Vec<(PathBuf, PathBuf)>, ToolError> {
    if moves.is_empty() || moves.len() > MAX_MOVES {
        return Err(ToolError::invalid(format!("Give between 1 and {MAX_MOVES} moves.")));
    }
    let roots = guard.root_list();
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for m in moves {
        let from = guard.existing(&m.from)?;
        if roots.contains(&display(&from)) {
            return Err(ToolError::denied("A permitted folder itself can't be moved."));
        }
        let to = guard.creatable(&m.to)?;
        if to.starts_with(&from) {
            return Err(ToolError::invalid(format!("Can't move {} into itself.", display(&from))));
        }
        if to.exists() && !overwrite {
            return Err(ToolError::new("already_exists", format!("{} already exists. Set `overwrite` to replace it.", display(&to))));
        }
        if to.is_dir() {
            return Err(ToolError::invalid(format!("{} is a folder; give the full destination path.", display(&to))));
        }
        if !create_dirs && !to.parent().is_some_and(Path::is_dir) {
            return Err(ToolError::not_found(format!("The destination folder for {} doesn't exist.", display(&to))));
        }
        if plan.iter().any(|(_, t)| t == &to) {
            return Err(ToolError::invalid(format!("Two items would end up at {}.", display(&to))));
        }
        plan.push((from, to));
    }
    Ok(plan)
}

fn preview_list(title: String, plan: &[(PathBuf, PathBuf)]) -> String {
    let mut s = title;
    for (from, to) in plan.iter().take(25) {
        s.push_str(&format!("\n• {} → {}", display(from), display(to)));
    }
    if plan.len() > 25 {
        s.push_str(&format!("\n• … and {} more", plan.len() - 25));
    }
    s
}

/// Across drives: copy → verify every file → delete the source. The source is only
/// removed after the whole copy verified.
fn cross_device_move(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        let copied = copy_tree(from, to)?;
        if !copied.complete {
            let _ = fs::remove_dir_all(to);
            return Err("stopped before the copy finished; the source was kept".into());
        }
        fs::remove_dir_all(from).map_err(|e| format!("copied and verified, but couldn't remove the source: {e}"))
    } else {
        fs::copy(from, to).map_err(|e| e.to_string())?;
        if !same_content(from, to) {
            let _ = fs::remove_file(to);
            return Err("the copy didn't verify; the source was kept".into());
        }
        fs::remove_file(from).map_err(|e| format!("copied and verified, but couldn't remove the source: {e}"))
    }
}

// ---- undo journal -------------------------------------------------------------------

const JOURNAL_KEEP: usize = 20;
static JOURNAL_FILE: OnceLock<PathBuf> = OnceLock::new();
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
pub struct JournalEntry {
    pub id: u64,
    /// Unix milliseconds.
    pub at: u64,
    pub label: String,
    /// Completed (from, to) pairs, as displayed paths.
    pub moves: Vec<(String, String)>,
}

/// Where undo information is kept (app config folder). Without it, nothing is journaled.
pub fn set_journal_dir(dir: &Path) {
    let _ = JOURNAL_FILE.set(dir.join("file_undo.json"));
}

fn read_journal() -> Vec<JournalEntry> {
    JOURNAL_FILE.get().and_then(|f| fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_journal(j: &[JournalEntry]) {
    if let Some(f) = JOURNAL_FILE.get() {
        if let Ok(text) = serde_json::to_string(j) {
            let tmp = f.with_extension("json.tmp");
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, f);
            }
        }
    }
}

fn journal(label: &str, moves: Vec<(String, String)>) {
    if moves.is_empty() || JOURNAL_FILE.get().is_none() {
        return;
    }
    let _l = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut j = read_journal();
    let at = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let id = j.iter().map(|e| e.id).max().unwrap_or(0) + 1;
    j.insert(0, JournalEntry { id, at, label: label.to_owned(), moves });
    j.truncate(JOURNAL_KEEP);
    write_journal(&j);
}

pub fn journal_list() -> Vec<JournalEntry> {
    let _l = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_journal()
}

/// The reverse moves for an undo, validated against the permitted folders.
fn undo_plan(guard: &PathGuard, id: u64) -> Result<(JournalEntry, Vec<(PathBuf, PathBuf)>), ToolError> {
    let entry = journal_list().into_iter().find(|e| e.id == id).ok_or_else(|| ToolError::not_found("That change is no longer in the undo history."))?;
    let mut plan = Vec::new();
    for (from, to) in entry.moves.iter().rev() {
        let now = guard.existing(to).map_err(|_| ToolError::invalid(format!("{to} is gone or outside the permitted folders; can't undo.")))?;
        let back = guard.creatable(from)?;
        if back.exists() {
            return Err(ToolError::new("already_exists", format!("{from} exists again; undo would overwrite it.")));
        }
        plan.push((now, back));
    }
    Ok((entry, plan))
}

pub fn undo_preview(guard: &PathGuard, id: u64) -> Result<String, ToolError> {
    let (entry, plan) = undo_plan(guard, id)?;
    Ok(preview_list(format!("Undo “{}” ({} moves back):", entry.label, plan.len()), &plan))
}

/// Moves files back; the journal entry is removed when everything was restored.
pub fn undo(guard: &PathGuard, id: u64) -> Result<ToolOutput, ToolError> {
    let (entry, plan) = undo_plan(guard, id)?;
    let out = run_moves_inner(&plan, false, true, None);
    if out.content["failed"] == 0 && out.content.get("cancelled").is_none() {
        let _l = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut j = read_journal();
        j.retain(|e| e.id != entry.id);
        write_journal(&j);
    }
    Ok(out)
}

fn run_moves(plan: &[(PathBuf, PathBuf)], overwrite: bool, create_dirs: bool, label: &str) -> ToolOutput {
    run_moves_inner(plan, overwrite, create_dirs, Some(label))
}

fn run_moves_inner(plan: &[(PathBuf, PathBuf)], overwrite: bool, create_dirs: bool, label: Option<&str>) -> ToolOutput {
    let mut results = Vec::new();
    let mut moved = 0;
    let mut stopped = false;
    let mut done: Vec<(String, String)> = Vec::new();
    for (i, (from, to)) in plan.iter().enumerate() {
        if ctx::cancelled() {
            stopped = true;
            break;
        }
        ctx::report(format!("Moving {} of {}…", i + 1, plan.len()));
        // Re-check at execution time: the folder may have changed since the preview.
        let r = if to.exists() && !overwrite {
            Err("destination exists".to_owned())
        } else {
            let made = if create_dirs { to.parent().map_or(Ok(()), fs::create_dir_all).map_err(|e| e.to_string()) } else { Ok(()) };
            made.and_then(|_| match fs::rename(from, to) {
                Err(e) if e.raw_os_error() == Some(CROSS_DEVICE) => cross_device_move(from, to),
                r => r.map_err(|e| e.to_string()),
            })
        };
        // Verify the outcome on disk rather than trusting the call.
        let ok = r.is_ok() && to.exists() && !from.exists();
        if ok {
            moved += 1;
            done.push((display(from), display(to)));
        }
        results.push(json!({ "from": display(from), "to": display(to), "ok": ok, "error": r.err() }));
    }
    if let Some(label) = label {
        journal(label, done);
    }
    let failed = results.len() - moved;
    let mut content = json!({ "results": results, "moved": moved, "failed": failed });
    if stopped {
        content["cancelled"] = json!(true);
        content["recovery"] = cancelled_note(moved, plan.len());
    }
    if label.is_some() && moved > 0 {
        content["undo"] = json!("Completed moves can be undone in Settings → File rules (undo history) or with undo_file_changes.");
    }
    let last = plan.last().map(|(_, to)| display(to));
    ToolOutput {
        content,
        summary: format!("Moved {moved} of {}{}", plan.len(), if stopped { " (stopped)" } else { "" }),
        file: last.filter(|_| moved > 0).map(|path| FileChange { path, kind: "moved" }),
    }
}

/// New names for files in one folder, from a template and/or find/replace.
fn rename_plan(guard: &PathGuard, a: &RenameArgs) -> Result<Vec<Move>, ToolError> {
    let dir = guard.existing(&a.path)?;
    if !dir.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&dir))));
    }
    if a.template.is_none() && a.find.is_none() {
        return Err(ToolError::invalid("Give a `template` and/or `find`/`replace`."));
    }
    let pattern = a.pattern.as_deref().unwrap_or("*").trim().to_lowercase();
    let mut truncated = false;
    let mut files: Vec<PathBuf> =
        files_under(&dir, false, 1, &mut truncated).into_iter().map(|(p, _)| p).filter(|p| wildcard(&pattern, &lower_name(p))).collect();
    files.sort();
    let mut moves = Vec::new();
    for (i, p) in files.iter().enumerate() {
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        let base = match (&a.find, &a.replace) {
            (Some(f), r) if !f.is_empty() => stem.replace(f.as_str(), r.as_deref().unwrap_or("")),
            _ => stem.clone(),
        };
        let name = match &a.template {
            Some(t) => render_template(t, &base, &ext, i + 1, date_parts(p))?,
            None if ext.is_empty() => base,
            None => format!("{base}.{ext}"),
        };
        if !valid_file_name(&name) {
            return Err(ToolError::invalid(format!("“{name}” isn't a valid file name.")));
        }
        if name != p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() {
            moves.push(Move { from: display(p), to: display(&p.with_file_name(&name)) });
        }
    }
    if moves.is_empty() {
        return Err(ToolError::invalid("No file names would change."));
    }
    Ok(moves)
}

fn render_template(t: &str, name: &str, ext: &str, n: usize, (y, m, d): (i64, i64, i64)) -> Result<String, ToolError> {
    let mut out = String::new();
    let mut rest = t;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let close = rest[open..].find('}').ok_or_else(|| ToolError::invalid("Unclosed `{` in template."))? + open;
        let token = &rest[open + 1..close];
        match token {
            "name" => out.push_str(name),
            "ext" => out.push_str(ext),
            "n" => out.push_str(&n.to_string()),
            "date" => out.push_str(&format!("{y:04}-{m:02}-{d:02}")),
            "year" => out.push_str(&format!("{y:04}")),
            "month" => out.push_str(&format!("{m:02}")),
            t if t.starts_with("n:") => {
                let width: usize = t[2..].parse().map_err(|_| ToolError::invalid(format!("Bad token {{{t}}}.")))?;
                out.push_str(&format!("{n:0width$}", width = width.min(9)));
            }
            other => return Err(ToolError::invalid(format!("Unknown template token {{{other}}}."))),
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Moves files of a folder into subfolders by extension, year or month.
fn organize_plan(guard: &PathGuard, a: &OrganizeArgs) -> Result<Vec<Move>, ToolError> {
    let dir = guard.existing(&a.path)?;
    if !dir.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&dir))));
    }
    let pattern = a.pattern.as_deref().unwrap_or("*").trim().to_lowercase();
    let exts: Vec<String> = a.extensions.clone().unwrap_or_default().iter().map(|e| e.trim().trim_start_matches('.').to_lowercase()).collect();
    let mut truncated = false;
    let mut moves = Vec::new();
    for (p, _) in files_under(&dir, false, 1, &mut truncated) {
        let lname = lower_name(&p);
        if !wildcard(&pattern, &lname) || (!exts.is_empty() && !exts.iter().any(|e| lname.ends_with(&format!(".{e}")))) {
            continue;
        }
        let (y, m, d) = date_parts(&p);
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let group = match a.by.as_str() {
            "extension" => Some(ext).filter(|e| !e.is_empty() && valid_file_name(e)).unwrap_or_else(|| "no extension".into()),
            "year" => format!("{y:04}"),
            "month" => format!("{y:04}-{m:02}"),
            "pattern" => {
                let t = a.target.as_deref().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| ToolError::invalid("by = pattern needs a `target`, e.g. \"Photos/{year}\"."))?;
                let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let rendered = render_template(t, &stem, &ext, 1, (y, m, d))?;
                // Each path segment must be a valid folder name; no "..".
                let segs: Vec<&str> = rendered.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
                if segs.is_empty() || segs.iter().any(|s| *s == ".." || *s == "." || !valid_file_name(s)) {
                    return Err(ToolError::invalid(format!("“{rendered}” isn't a valid subfolder path.")));
                }
                segs.join("\\")
            }
            other => return Err(ToolError::invalid(format!("`by` must be extension, year, month or pattern, not `{other}`."))),
        };
        let Some(name) = p.file_name() else { continue };
        moves.push(Move { from: display(&p), to: display(&dir.join(&group).join(name)) });
    }
    if moves.is_empty() {
        return Err(ToolError::invalid("No matching files to organize."));
    }
    Ok(moves)
}

/// For tools that preview their changes: Some(always_ask) — replacing files always asks.
pub fn needs_preview(guard: &PathGuard, tool: &str, args: &Value) -> Option<bool> {
    match tool {
        "move_files" => Some(args.get("overwrite").and_then(Value::as_bool).unwrap_or(false)),
        "rename_files" | "organize_files" | "undo_file_changes" => Some(false),
        "copy_files" => Some(copy_replaces_files(guard, args)),
        _ => None,
    }
}

pub fn preview(guard: &PathGuard, tool: &str, args: &Value) -> Result<String, ToolError> {
    match tool {
        "move_files" => {
            let a: MoveArgs = super::parse(args)?;
            let plan = plan_move_list(guard, &a.moves, a.overwrite, false)?;
            Ok(preview_list(format!("Move/rename {} item(s){}:", plan.len(), if a.overwrite { ", replacing existing files" } else { "" }), &plan))
        }
        "rename_files" => {
            let a: RenameArgs = super::parse(args)?;
            let plan = plan_move_list(guard, &rename_plan(guard, &a)?, false, false)?;
            Ok(preview_list(format!("Rename {} file(s):", plan.len()), &plan))
        }
        "organize_files" => {
            let a: OrganizeArgs = super::parse(args)?;
            let plan = plan_move_list(guard, &organize_plan(guard, &a)?, false, true)?;
            Ok(preview_list(format!("Organize {} file(s) into folders by {}:", plan.len(), a.by), &plan))
        }
        "copy_files" => copy_preview(guard, args),
        "undo_file_changes" => undo_preview(guard, undo_id(args)?),
        _ => Err(ToolError::invalid("No preview for this tool.")),
    }
}

fn undo_id(args: &Value) -> Result<u64, ToolError> {
    args.get("id").and_then(Value::as_u64).ok_or_else(|| ToolError::invalid("Give the `id` of a change from list_file_changes."))
}

pub fn undo_tool(guard: &PathGuard, args: &Value) -> Result<ToolOutput, ToolError> {
    undo(guard, undo_id(args)?)
}

pub fn list_changes_tool() -> Result<ToolOutput, ToolError> {
    let j = journal_list();
    let n = j.len();
    Ok(ToolOutput {
        content: json!({ "changes": j.iter().map(|e| json!({ "id": e.id, "at": e.at, "label": e.label, "moves": e.moves.len() })).collect::<Vec<_>>() }),
        summary: format!("{n} undoable file changes"),
        file: None,
    })
}

pub fn move_files(guard: &PathGuard, args: MoveArgs) -> Result<ToolOutput, ToolError> {
    let plan = plan_move_list(guard, &args.moves, args.overwrite, false)?;
    Ok(run_moves(&plan, args.overwrite, false, &format!("Move {} item(s)", plan.len())))
}

pub fn rename_files(guard: &PathGuard, args: RenameArgs) -> Result<ToolOutput, ToolError> {
    let plan = plan_move_list(guard, &rename_plan(guard, &args)?, false, false)?;
    Ok(run_moves(&plan, false, false, &format!("Rename {} file(s)", plan.len())))
}

pub fn organize_files(guard: &PathGuard, args: OrganizeArgs) -> Result<ToolOutput, ToolError> {
    let plan = plan_move_list(guard, &organize_plan(guard, &args)?, false, true)?;
    Ok(run_moves(&plan, false, true, &format!("Organize {} file(s) by {}", plan.len(), args.by)))
}

// ---- duplicates -----------------------------------------------------------------

pub fn find_duplicates(guard: &PathGuard, args: DuplicateArgs) -> Result<ToolOutput, ToolError> {
    let root = guard.existing(&args.path)?;
    if !root.is_dir() {
        return Err(ToolError::invalid(format!("{} is not a directory.", display(&root))));
    }
    let mut truncated = false;
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for (p, size) in files_under(&root, args.recursive, MAX_DEPTH, &mut truncated) {
        if size > 0 {
            by_size.entry(size).or_default().push(p);
        }
    }
    let candidates: usize = by_size.values().filter(|v| v.len() > 1).map(Vec::len).sum();
    let mut hashed = 0;
    let mut groups: Vec<Value> = Vec::new();
    let mut wasted: u64 = 0;
    'outer: for (size, paths) in by_size.into_iter().filter(|(_, v)| v.len() > 1) {
        let mut by_hash: HashMap<String, Vec<PathBuf>> = HashMap::new();
        for p in paths {
            if ctx::cancelled() {
                truncated = true;
                break 'outer;
            }
            hashed += 1;
            ctx::report(format!("Comparing {hashed} of {candidates} candidate files…"));
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

// ---- copy ------------------------------------------------------------------------

fn conflict_mode(m: &Option<String>) -> Result<&'static str, ToolError> {
    match m.as_deref().unwrap_or("skip") {
        "skip" => Ok("skip"),
        "rename" => Ok("rename"),
        "overwrite" => Ok("overwrite"),
        other => Err(ToolError::invalid(format!("`on_conflict` must be skip, rename or overwrite, not `{other}`."))),
    }
}

/// "name (2).ext", "name (3).ext", … — the first that doesn't exist.
fn free_name(p: &Path) -> Option<PathBuf> {
    let stem = p.file_stem()?.to_string_lossy().into_owned();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..1000).map(|n| p.with_file_name(format!("{stem} ({n}){ext}"))).find(|c| !c.exists())
}

/// (source, destination, destination exists, file count for folders)
type CopyPlan = Vec<(PathBuf, PathBuf, bool, Option<usize>)>;

fn plan_copies(guard: &PathGuard, args: &CopyArgs) -> Result<CopyPlan, ToolError> {
    conflict_mode(&args.on_conflict)?;
    if args.copies.is_empty() || args.copies.len() > MAX_MOVES {
        return Err(ToolError::invalid(format!("Give between 1 and {MAX_MOVES} copies.")));
    }
    let mut plan = Vec::new();
    for c in &args.copies {
        let from = guard.existing(&c.from)?;
        let to = guard.creatable(&c.to)?;
        if to == from || to.starts_with(&from) {
            return Err(ToolError::invalid(format!("Can't copy {} onto or into itself.", display(&from))));
        }
        if !to.parent().is_some_and(Path::is_dir) {
            return Err(ToolError::not_found(format!("The destination folder for {} doesn't exist.", display(&to))));
        }
        let files = if from.is_dir() {
            let mut truncated = false;
            let n = files_under(&from, true, MAX_COPY_DEPTH, &mut truncated).len();
            if truncated || n > MAX_FOLDER_FILES {
                return Err(ToolError::denied(format!("{} has too many files to copy in one step.", display(&from))));
            }
            Some(n)
        } else if to.is_dir() {
            return Err(ToolError::invalid(format!("{} is a folder; give the full destination path.", display(&to))));
        } else {
            None
        };
        let exists = to.exists();
        plan.push((from, to, exists, files));
    }
    Ok(plan)
}

pub fn copy_preview(guard: &PathGuard, args: &Value) -> Result<String, ToolError> {
    let a: CopyArgs = super::parse(args)?;
    let mode = conflict_mode(&a.on_conflict)?;
    let plan = plan_copies(guard, &a)?;
    let conflicts = plan.iter().filter(|p| p.2).count();
    let mut s = format!("Copy {} item(s)", plan.len());
    if conflicts > 0 {
        s.push_str(&format!(
            "; {conflicts} already exist and will be {}",
            match mode {
                "overwrite" => "REPLACED (folders: existing files with the same names are replaced)",
                "rename" => "kept (copies get a new name)",
                _ => "skipped",
            }
        ));
    }
    s.push(':');
    for (from, to, exists, files) in plan.iter().take(25) {
        let what = files.map(|n| format!(" (folder, {n} files)")).unwrap_or_default();
        s.push_str(&format!("\n• {}{what} → {}{}", display(from), display(to), if *exists { " (exists)" } else { "" }));
    }
    if plan.len() > 25 {
        s.push_str(&format!("\n• … and {} more", plan.len() - 25));
    }
    Ok(s)
}

/// True if the copy replaces existing files (always asks).
pub fn copy_replaces_files(guard: &PathGuard, args: &Value) -> bool {
    let Ok(a) = super::parse::<CopyArgs>(args) else { return false };
    matches!(conflict_mode(&a.on_conflict), Ok("overwrite")) && plan_copies(guard, &a).is_ok_and(|p| p.iter().any(|c| c.2))
}

struct TreeCopy {
    files: usize,
    complete: bool,
}

/// Recursively copies a folder (structure and files), verifying every file. Stops
/// between files when cancelled; never follows symlinks.
fn copy_tree(from: &Path, to: &Path) -> Result<TreeCopy, String> {
    let mut truncated = false;
    let files = files_under(from, true, MAX_COPY_DEPTH, &mut truncated);
    if truncated && !ctx::cancelled() {
        return Err("too many files".into());
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    // Empty subfolders too.
    let mut dirs = vec![from.to_path_buf()];
    while let Some(d) = dirs.pop() {
        for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
            if e.path().symlink_metadata().is_ok_and(|m| m.is_dir()) {
                let rel = e.path().strip_prefix(from).map_err(|e| e.to_string())?.to_path_buf();
                fs::create_dir_all(to.join(rel)).map_err(|e| e.to_string())?;
                dirs.push(e.path());
            }
        }
    }
    let total = files.len();
    for (i, (f, _)) in files.iter().enumerate() {
        if ctx::cancelled() {
            return Ok(TreeCopy { files: i, complete: false });
        }
        ctx::report(format!("Copying file {} of {total}…", i + 1));
        let rel = f.strip_prefix(from).map_err(|e| e.to_string())?;
        let target = to.join(rel);
        fs::copy(f, &target).map_err(|e| format!("{}: {e}", display(f)))?;
        if !same_content(f, &target) {
            let _ = fs::remove_file(&target);
            return Err(format!("{} didn't verify after copying", display(f)));
        }
    }
    Ok(TreeCopy { files: total, complete: true })
}

pub fn copy_files(guard: &PathGuard, args: CopyArgs) -> Result<ToolOutput, ToolError> {
    let mode = conflict_mode(&args.on_conflict)?;
    let plan = plan_copies(guard, &args)?;
    let mut results = Vec::new();
    let (mut copied, mut skipped) = (0, 0);
    let mut stopped = false;
    for (i, (from, to, _, files)) in plan.iter().enumerate() {
        if ctx::cancelled() {
            stopped = true;
            break;
        }
        ctx::report(format!("Copying item {} of {}…", i + 1, plan.len()));
        let target = if to.exists() {
            match mode {
                "skip" => {
                    skipped += 1;
                    results.push(json!({ "from": display(from), "to": display(to), "ok": false, "skipped": true, "error": "destination exists" }));
                    continue;
                }
                "rename" => match free_name(to) {
                    Some(t) => t,
                    None => {
                        results.push(json!({ "from": display(from), "to": display(to), "ok": false, "error": "no free name" }));
                        continue;
                    }
                },
                _ => to.clone(),
            }
        } else {
            to.clone()
        };
        let (ok, error, count) = if files.is_some() {
            match copy_tree(from, &target) {
                Ok(t) if t.complete => (true, None, t.files),
                Ok(t) => {
                    stopped = true;
                    (false, Some("stopped; this folder copy is incomplete".to_owned()), t.files)
                }
                Err(e) => (false, Some(e), 0),
            }
        } else {
            let r = fs::copy(from, &target).map_err(|e| e.to_string());
            // Verify: same size and SHA-256 as the source.
            let ok = r.is_ok() && same_content(from, &target);
            (ok, r.err().or((!ok).then(|| "copy didn't verify".to_owned())), usize::from(ok))
        };
        if ok {
            copied += 1;
        }
        results.push(json!({ "from": display(from), "to": display(&target), "ok": ok, "files": count, "error": error }));
        if stopped {
            break;
        }
    }
    let failed = results.len() - copied - skipped;
    let mut content = json!({ "results": results, "copied": copied, "skipped": skipped, "failed": failed });
    if stopped {
        content["cancelled"] = json!(true);
        content["recovery"] = cancelled_note(copied, plan.len());
    }
    Ok(ToolOutput {
        content,
        summary: format!(
            "Copied {copied} of {}{}{}",
            plan.len(),
            if skipped > 0 { format!(" ({skipped} skipped)") } else { String::new() },
            if stopped { " (stopped)" } else { "" }
        ),
        file: None,
    })
}

// ---- delete --------------------------------------------------------------------

/// What a delete would remove: canonical paths, each a file or (if allowed) a folder with its file count.
fn plan_deletes(guard: &PathGuard, args: &DeleteArgs) -> Result<Vec<(PathBuf, Option<usize>)>, ToolError> {
    if args.paths.is_empty() || args.paths.len() > MAX_DELETES {
        return Err(ToolError::invalid(format!("Give between 1 and {MAX_DELETES} paths.")));
    }
    let roots = guard.root_list();
    let mut plan: Vec<(PathBuf, Option<usize>)> = Vec::new();
    for raw in &args.paths {
        let p = guard.existing(raw)?;
        let shown = display(&p);
        if roots.iter().any(|r| r == &shown || Path::new(r).starts_with(Path::new(&shown))) {
            return Err(ToolError::denied(format!("{shown} is (or contains) a permitted folder and can't be deleted.")));
        }
        let meta = p.symlink_metadata().map_err(|e| ToolError::io(&p, &e))?;
        let entries = if meta.is_dir() {
            if !args.include_folders {
                return Err(ToolError::invalid(format!("{shown} is a folder. Set include_folders to delete folders.")));
            }
            let mut truncated = false;
            let n = files_under(&p, true, MAX_COPY_DEPTH, &mut truncated).len();
            if truncated || n > MAX_FOLDER_FILES {
                return Err(ToolError::denied(format!("{shown} contains too many files to delete in one step.")));
            }
            Some(n)
        } else {
            None
        };
        if plan.iter().any(|(q, _)| p.starts_with(q) || q.starts_with(&p)) {
            return Err(ToolError::invalid(format!("{shown} overlaps another path in the list.")));
        }
        plan.push((p, entries));
    }
    Ok(plan)
}

pub fn delete_preview(guard: &PathGuard, args: &Value) -> Result<String, ToolError> {
    let a: DeleteArgs = super::parse(args)?;
    let plan = plan_deletes(guard, &a)?;
    let mut s = format!("Move {} item(s) to the Recycle Bin:", plan.len());
    for (p, entries) in &plan {
        match entries {
            Some(n) => s.push_str(&format!("\n• {} (folder, {n} files)", display(p))),
            None => s.push_str(&format!("\n• {}", display(p))),
        }
    }
    Ok(s)
}

pub fn delete_files(guard: &PathGuard, args: DeleteArgs) -> Result<ToolOutput, ToolError> {
    let plan = plan_deletes(guard, &args)?;
    let mut results = Vec::new();
    let mut deleted = 0;
    let mut stopped = false;
    for (i, (p, _)) in plan.iter().enumerate() {
        if ctx::cancelled() {
            stopped = true;
            break;
        }
        ctx::report(format!("Recycling {} of {}…", i + 1, plan.len()));
        let r = recycle(p);
        // Verify on disk.
        let ok = r.is_ok() && !p.exists();
        if ok {
            deleted += 1;
        }
        results.push(json!({ "path": display(p), "ok": ok, "error": r.err().or((!ok).then(|| "still exists".to_owned())) }));
    }
    let mut content = json!({
        "results": results, "deleted": deleted, "failed": results.len() - deleted,
        "note": "Deleted items are in the Recycle Bin and can be restored there.",
    });
    if stopped {
        content["cancelled"] = json!(true);
        content["recovery"] = cancelled_note(deleted, plan.len());
    }
    Ok(ToolOutput {
        content,
        summary: format!("Moved {deleted} of {} to the Recycle Bin{}", plan.len(), if stopped { " (stopped)" } else { "" }),
        file: plan.first().filter(|_| deleted > 0).map(|(p, _)| FileChange { path: display(p), kind: "deleted" }),
    })
}

/// Sends one file or folder to the Recycle Bin (recoverable), without UI.
#[cfg(windows)]
fn recycle(p: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, SHFILEOPSTRUCTW};
    // pFrom is a double-NUL-terminated list; strip the \\?\ prefix, which the shell API doesn't accept.
    let path = display(p);
    let wide: Vec<u16> = path.encode_utf16().chain([0, 0]).collect();
    // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI
    let flags: u32 = 0x0004 | 0x0010 | 0x0040 | 0x0400;
    let mut op = SHFILEOPSTRUCTW {
        wFunc: 3, // FO_DELETE
        pFrom: PCWSTR(wide.as_ptr()),
        fFlags: flags as _,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("Windows couldn't recycle it (code {code})."));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("The operation was cancelled.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn recycle(_: &Path) -> Result<(), String> {
    Err("Deleting to the Recycle Bin is only supported on Windows.".into())
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
    fn civil_dates_round_trip() {
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2026, 10, 25), (2100, 12, 31)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        assert_eq!(parse_date("1970-01-02").unwrap(), 86_400);
        assert!(parse_date("tomorrow").is_err());
    }

    #[test]
    fn moves_are_previewed_verified_and_confined() {
        let (g, dir) = guard("move");
        fs::write(dir.join("a.txt"), "x").unwrap();
        let args = json!({ "moves": [{ "from": "a.txt", "to": "sub/b.txt" }] });
        assert!(preview(&g, "move_files", &args).unwrap().contains("b.txt"));
        let out = move_files(&g, serde_json::from_value(args).unwrap()).unwrap();
        assert_eq!(out.content["moved"], 1);
        assert!(dir.join("sub/b.txt").exists());
        let escape = json!({ "moves": [{ "from": "sub/b.txt", "to": "../escape.txt" }] });
        assert!(preview(&g, "move_files", &escape).is_err());
    }

    #[test]
    fn renames_with_templates_and_organizes() {
        let (g, dir) = guard("rename");
        fs::write(dir.join("b.txt"), "1").unwrap();
        fs::write(dir.join("a.pdf"), "2").unwrap();
        let r: RenameArgs = serde_json::from_value(json!({ "path": display(&dir), "template": "doc_{n:2}.{ext}" })).unwrap();
        let out = rename_files(&g, r).unwrap();
        assert_eq!(out.content["moved"], 2);
        assert!(dir.join("doc_01.pdf").exists() && dir.join("doc_02.txt").exists());
        let o: OrganizeArgs = serde_json::from_value(json!({ "path": display(&dir), "by": "extension" })).unwrap();
        organize_files(&g, o).unwrap();
        assert!(dir.join("pdf/doc_01.pdf").exists() && dir.join("txt/doc_02.txt").exists());
        let bad: OrganizeArgs = serde_json::from_value(json!({ "path": display(&dir.join("pdf")), "by": "pattern", "target": "../escape" })).unwrap();
        assert!(organize_files(&g, bad).is_err());
        assert!(render_template("{nope}", "a", "b", 1, (2026, 1, 1)).is_err());
    }

    #[test]
    fn document_search_ranks_relevant_paragraphs() {
        let (g, dir) = guard("docs");
        fs::write(dir.join("a.md"), "Intro text.\n\nThe warranty lasts two years from purchase.\n").unwrap();
        fs::write(dir.join("b.txt"), "Unrelated notes about lunch.").unwrap();
        let a: DocSearchArgs = serde_json::from_value(json!({ "path": display(&dir), "query": "How long is the warranty?" })).unwrap();
        let out = document_search(&g, a).unwrap();
        assert!(out.content["results"][0]["file"].as_str().unwrap().ends_with("a.md"));
        assert!(out.content["results"][0]["excerpt"].as_str().unwrap().contains("two years"));
    }

    #[test]
    fn content_search_returns_snippets() {
        let (g, dir) = guard("search");
        fs::write(dir.join("notes.txt"), "first line\nthe Quarterly budget is here\n").unwrap();
        fs::write(dir.join("other.txt"), "nothing").unwrap();
        let a: SearchArgs = serde_json::from_value(json!({ "path": display(&dir), "contains": "quarterly", "extensions": ["txt"] })).unwrap();
        let out = search_files(&g, a).unwrap();
        let m = &out.content["matches"][0];
        assert_eq!(m["line"], 2);
        assert!(m["snippet"].as_str().unwrap().contains("Quarterly budget"));
    }

    #[test]
    fn copies_files_and_folders_with_verification() {
        let (g, dir) = guard("copy");
        fs::write(dir.join("a.txt"), "hello").unwrap();
        fs::write(dir.join("sub/a.txt"), "old").unwrap();
        fs::create_dir_all(dir.join("sub/deep/empty")).unwrap();
        let args = |mode: &str| serde_json::from_value::<CopyArgs>(json!({ "copies": [{ "from": "a.txt", "to": "sub/a.txt" }], "on_conflict": mode })).unwrap();
        assert_eq!(copy_files(&g, args("skip")).unwrap().content["skipped"], 1);
        assert_eq!(copy_files(&g, args("rename")).unwrap().content["copied"], 1);
        assert!(dir.join("sub/a (2).txt").exists());
        assert!(copy_replaces_files(&g, &json!({ "copies": [{ "from": "a.txt", "to": "sub/a.txt" }], "on_conflict": "overwrite" })));
        let folder: CopyArgs = serde_json::from_value(json!({ "copies": [{ "from": "sub", "to": "copy_of_sub" }] })).unwrap();
        assert_eq!(copy_files(&g, folder).unwrap().content["copied"], 1);
        assert!(dir.join("copy_of_sub/a.txt").exists() && dir.join("copy_of_sub/deep/empty").is_dir());
        let into_self: CopyArgs = serde_json::from_value(json!({ "copies": [{ "from": "sub", "to": "sub/inner" }] })).unwrap();
        assert!(copy_files(&g, into_self).is_err());
    }

    #[test]
    fn delete_plan_refuses_roots_and_unflagged_folders() {
        let (g, dir) = guard("del");
        fs::write(dir.join("sub/x.txt"), "x").unwrap();
        assert!(delete_preview(&g, &json!({ "paths": [display(&dir)] })).is_err());
        assert!(delete_preview(&g, &json!({ "paths": ["sub"] })).is_err());
        assert!(delete_preview(&g, &json!({ "paths": ["sub"], "include_folders": true })).unwrap().contains("1 files"));
        assert!(delete_preview(&g, &json!({ "paths": ["../outside.txt"] })).is_err());
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
