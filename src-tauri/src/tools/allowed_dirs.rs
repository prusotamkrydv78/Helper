//! The user's list of folders the tools may access, persisted as JSON in the
//! app config directory. Empty by default: no file access until the user adds one.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::error::{AppError, ErrorKind};

use super::paths::display;

pub struct AllowedDirs {
    file: PathBuf,
    dirs: RwLock<Vec<PathBuf>>,
}

impl AllowedDirs {
    pub fn load(config_dir: &Path) -> Self {
        let file = config_dir.join("allowed_dirs.json");
        let dirs: Vec<PathBuf> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .collect();
        log::info!("{} permitted folder(s) loaded", dirs.len());
        Self { file, dirs: RwLock::new(dirs) }
    }

    pub fn snapshot(&self) -> Vec<PathBuf> {
        self.dirs.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn list(&self) -> Vec<String> {
        self.snapshot().iter().map(|p| display(p)).collect()
    }

    pub fn add(&self, path: &Path) -> Result<Vec<String>, AppError> {
        let canonical = path
            .canonicalize()
            .map_err(|e| AppError::new(ErrorKind::InvalidRequest, format!("Can't use that folder: {e}")))?;
        if !canonical.is_dir() {
            return Err(AppError::invalid("Choose a folder, not a file."));
        }
        // A drive root (prefix + root only) would grant access to the whole disk.
        if canonical.components().count() <= 2 {
            return Err(AppError::invalid("Choose a specific folder rather than a whole drive."));
        }
        {
            let mut dirs = self.dirs.write().unwrap_or_else(|e| e.into_inner());
            if !dirs.iter().any(|d| d == &canonical) {
                dirs.push(canonical.clone());
            }
        }
        self.persist()?;
        log::info!("permitted folder added: {}", display(&canonical));
        Ok(self.list())
    }

    pub fn remove(&self, path: &str) -> Result<Vec<String>, AppError> {
        {
            let mut dirs = self.dirs.write().unwrap_or_else(|e| e.into_inner());
            dirs.retain(|d| display(d) != path);
        }
        self.persist()?;
        log::info!("permitted folder removed: {path}");
        Ok(self.list())
    }

    fn persist(&self) -> Result<(), AppError> {
        let list: Vec<String> = self.snapshot().iter().map(|p| p.display().to_string()).collect();
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::new(ErrorKind::Storage, e.to_string()))?;
        }
        let json = serde_json::to_string_pretty(&list).map_err(|e| AppError::internal(e.to_string()))?;
        std::fs::write(&self.file, json).map_err(|e| AppError::new(ErrorKind::Storage, e.to_string()))
    }
}
