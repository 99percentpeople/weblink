//! Bounded file staging shared by native content operations.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;

pub const DEFAULT_LIMIT: usize = 64 * 1024 * 1024;
pub const MAX_LIMIT: usize = 512 * 1024 * 1024;
pub fn file_limit(value: Option<usize>) -> Result<usize, String> {
    match value.unwrap_or(DEFAULT_LIMIT) {
        limit @ 1..=MAX_LIMIT => Ok(limit),
        _ => Err("Invalid file size limit".into()),
    }
}
pub const MAX_ENTRIES: usize = 4096;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub name: String,
    pub data: String,
}
pub struct StagedFiles {
    pub directory: tempfile::TempDir,
    pub paths: Vec<String>,
    pub bytes: usize,
}
pub fn file_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name.len() > 240
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("Invalid filename".into());
    }
    Ok(())
}
pub fn stage(entries: Vec<FileEntry>, limit: usize) -> Result<StagedFiles, String> {
    let limit = file_limit(Some(limit))?;
    if entries.is_empty() || entries.len() > MAX_ENTRIES {
        return Err("Invalid file count".into());
    }
    let mut staged = StagedFiles {
        directory: tempfile::tempdir().map_err(|e| e.to_string())?,
        paths: Vec::new(),
        bytes: 0,
    };
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        file_name(&entry.name)?;
        if !seen.insert(entry.name.to_lowercase()) {
            return Err("Duplicate filename".into());
        }
        if entry.data.len() > (limit - staged.bytes) * 4 / 3 + 4 {
            return Err(format!(
                "Files exceed the {} MiB limit",
                limit as f64 / 1024.0 / 1024.0
            ));
        }
        let data = STANDARD.decode(entry.data).map_err(|e| e.to_string())?;
        staged.bytes += data.len();
        if staged.bytes > limit {
            return Err(format!(
                "Files exceed the {} MiB limit",
                limit as f64 / 1024.0 / 1024.0
            ));
        }
        let path = staged.directory.path().join(entry.name);
        std::fs::write(&path, data).map_err(|e| e.to_string())?;
        staged.paths.push(path.to_string_lossy().into_owned());
    }
    Ok(staged)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_file_limits_and_counts_all_staged_files() {
        assert_eq!(file_limit(None).unwrap(), DEFAULT_LIMIT);
        assert_eq!(
            file_limit(Some(128 * 1024 * 1024)).unwrap(),
            128 * 1024 * 1024
        );
        assert!(file_limit(Some(0)).is_err());
        assert!(file_limit(Some(MAX_LIMIT + 1)).is_err());
        let files = || {
            vec![
                FileEntry {
                    name: "a".into(),
                    data: STANDARD.encode([1, 2, 3]),
                },
                FileEntry {
                    name: "b".into(),
                    data: STANDARD.encode([4, 5]),
                },
            ]
        };
        assert_eq!(stage(files(), 5).unwrap().bytes, 5);
        assert!(stage(files(), 4).is_err());
    }
    #[test]
    fn rejects_paths_and_duplicate_names() {
        for name in ["../a", "a\\b", "C:a", "NUL.txt", "COM1", "a.", "a ", ""] {
            assert!(file_name(name).is_err());
        }
        assert!(file_name("文件.zip").is_ok());
        assert!(stage(
            vec![
                FileEntry {
                    name: "a".into(),
                    data: "".into()
                },
                FileEntry {
                    name: "A".into(),
                    data: "".into()
                }
            ],
            DEFAULT_LIMIT
        )
        .is_err());
    }
    #[test]
    fn stages_real_file_bytes() {
        let staged = stage(
            vec![FileEntry {
                name: "a.bin".into(),
                data: STANDARD.encode([0, 255, 42]),
            }],
            DEFAULT_LIMIT,
        )
        .unwrap();
        assert_eq!(std::fs::read(&staged.paths[0]).unwrap(), [0, 255, 42]);
    }
}
