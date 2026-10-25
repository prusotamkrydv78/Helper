//! Confines tool file access to user-approved folders.
//!
//! Every path is resolved to its canonical form (symlinks and `..` resolved by
//! the OS) and must lie inside a canonical allowed root. `..` components are
//! rejected up front, so a path can't name its way out of a root either.

use std::path::{Component, Path, PathBuf};

use super::ToolError;

pub struct PathGuard {
    roots: Vec<PathBuf>,
}

impl PathGuard {
    /// Roots that no longer exist are dropped.
    pub fn new(roots: &[PathBuf]) -> Self {
        Self { roots: roots.iter().filter_map(|r| r.canonicalize().ok()).collect() }
    }

    pub fn has_roots(&self) -> bool {
        !self.roots.is_empty()
    }

    fn candidate(&self, raw: &str) -> Result<PathBuf, ToolError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(ToolError::invalid("`path` must not be empty."));
        }
        let p = Path::new(raw);
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(ToolError::denied("Paths may not contain `..`."));
        }
        if p.is_absolute() {
            return Ok(p.to_path_buf());
        }
        match self.roots.as_slice() {
            [] => Err(ToolError::denied("No folders are permitted. Ask the user to add one in Settings.")),
            [only] => Ok(only.join(p)),
            _ => Err(ToolError::invalid(
                "Several folders are permitted; use an absolute path inside one of them.",
            )),
        }
    }

    fn ensure_inside(&self, canonical: &Path) -> Result<(), ToolError> {
        if self.roots.iter().any(|r| canonical.starts_with(r)) {
            Ok(())
        } else {
            Err(ToolError::denied(format!(
                "{} is outside the permitted folders.",
                display(canonical)
            )))
        }
    }

    /// Resolves a path that must already exist.
    pub fn existing(&self, raw: &str) -> Result<PathBuf, ToolError> {
        let c = self.candidate(raw)?;
        let canonical = c.canonicalize().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ToolError::not_found(format!("{} does not exist.", display(&c))),
            _ => ToolError::io(&c, &e),
        })?;
        self.ensure_inside(&canonical)?;
        Ok(canonical)
    }

    /// Resolves a path that may not exist yet (for creation). The nearest existing
    /// ancestor must be inside a permitted folder.
    pub fn creatable(&self, raw: &str) -> Result<PathBuf, ToolError> {
        let c = self.candidate(raw)?;
        if c.exists() {
            return self.existing(raw);
        }
        let mut ancestor = c.as_path();
        let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
        loop {
            match ancestor.parent() {
                Some(parent) => {
                    rest.push(ancestor.file_name().ok_or_else(|| ToolError::invalid("Invalid path."))?);
                    ancestor = parent;
                    if ancestor.exists() {
                        break;
                    }
                }
                None => return Err(ToolError::denied(format!("{} is outside the permitted folders.", display(&c)))),
            }
        }
        let base = ancestor.canonicalize().map_err(|e| ToolError::io(ancestor, &e))?;
        self.ensure_inside(&base)?;
        Ok(rest.iter().rev().fold(base, |acc, part| acc.join(part)))
    }

    /// Roots as user-readable strings.
    pub fn root_list(&self) -> Vec<String> {
        self.roots.iter().map(|r| display(r)).collect()
    }
}

/// Strips the Windows verbatim prefix (`\\?\`) so paths read naturally.
pub fn display(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-automation-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("inside")).unwrap();
        std::fs::write(dir.join("inside/a.txt"), "hi").unwrap();
        dir
    }

    #[test]
    fn allows_paths_inside_root() {
        let root = temp_root("inside");
        let g = PathGuard::new(&[root.join("inside")]);
        assert!(g.existing("a.txt").is_ok());
        assert!(g.existing(&root.join("inside/a.txt").display().to_string()).is_ok());
        assert!(g.creatable("new/deeper/file.txt").is_ok());
    }

    #[test]
    fn blocks_traversal_and_outside_paths() {
        let root = temp_root("outside");
        let g = PathGuard::new(&[root.join("inside")]);
        assert!(g.existing("../inside/a.txt").is_err());
        assert!(g.creatable("sub/../../escape.txt").is_err());
        let outside = std::env::temp_dir().display().to_string();
        assert!(g.existing(&outside).is_err());
        assert!(g.creatable(&root.join("sibling.txt").display().to_string()).is_err());
    }

    #[test]
    fn no_roots_means_no_access() {
        let g = PathGuard::new(&[]);
        assert!(!g.has_roots());
        assert!(g.existing("a.txt").is_err());
    }
}
