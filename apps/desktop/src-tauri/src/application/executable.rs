use std::path::Path;

/// Normalize Windows spelling and filesystem aliases without requiring an old
/// startup target to still exist on disk.
pub fn normalized_path(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let path = canonical.to_string_lossy().replace('/', "\\");
    path.strip_prefix(r"\\?\UNC\")
        .map(|suffix| format!(r"\\{suffix}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned())
}
