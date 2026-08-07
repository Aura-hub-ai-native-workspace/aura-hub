//! AURA Hub — Tauri core.
//!
//! Deliberately thin. The desktop wrapper's only job today is to host
//! the web environment in a native window. Native capabilities (file
//! system access, local model runners, system integration) will be
//! added here as tightly-scoped `#[tauri::command]`s — one clean seam
//! between the environment and the operating system.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

/// A trivial command kept as a wiring example / health check for the
/// JS <-> Rust bridge. Remove or replace when real commands land.
#[tauri::command]
fn environment_ping() -> String {
    "aura://ready".to_string()
}

/// Directories the Code Workspace never lists — generated/vendored
/// trees that would otherwise blow up tree size and response time on
/// real-world projects.
const IGNORED_DIRS: [&str; 9] = [
    "node_modules",
    ".git",
    "dist",
    "dist-ssr",
    "build",
    "target",
    ".next",
    ".turbo",
    "coverage",
];

#[derive(Serialize)]
struct CodeFsEntry {
    name: String,
    /// Posix-style path relative to the project root.
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

/// Resolves `rel_path` against `root` and guarantees the result is still
/// inside `root` (canonicalized on both sides). This is the only thing
/// standing between the Code Workspace and an arbitrary-file-read/write
/// bug via a crafted `../../` path, so every fs command below must go
/// through it — never touch `std::fs` with a raw client-supplied path.
fn resolve_within_root(root: &str, rel_path: &str) -> Result<PathBuf, String> {
    let root_canonical = fs::canonicalize(root).map_err(|e| format!("Invalid project root: {e}"))?;
    let candidate = if rel_path.is_empty() {
        root_canonical.clone()
    } else {
        root_canonical.join(rel_path.replace('\\', "/"))
    };
    let candidate_canonical = fs::canonicalize(&candidate).map_err(|e| format!("Path not found: {e}"))?;
    if !candidate_canonical.starts_with(&root_canonical) {
        return Err("Path escapes project root".into());
    }
    Ok(candidate_canonical)
}

/// One directory level, lazily — the Explorer only calls this for a
/// folder the user actually expanded.
#[tauri::command]
fn code_read_dir(root: String, rel_path: String) -> Result<Vec<CodeFsEntry>, String> {
    let dir = resolve_within_root(&root, &rel_path)?;
    if !dir.is_dir() {
        return Err("Not a directory".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        // Dotfiles are hidden by default (matches the repo's own
        // .gitignore intent) — keeps the tree from opening on a wall of
        // .env / .DS_Store / editor-config noise.
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let rel = if rel_path.is_empty() {
            name.clone()
        } else {
            format!("{rel_path}/{name}")
        };
        entries.push(CodeFsEntry { name, path: rel, is_dir: file_type.is_dir() });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Reads a real file's contents. Rejects anything above ~5MB — Monaco
/// isn't a hex-dump tool, and this keeps a giant binary from freezing
/// the IPC bridge.
#[tauri::command]
fn code_read_file(root: String, rel_path: String) -> Result<String, String> {
    let file = resolve_within_root(&root, &rel_path)?;
    if !file.is_file() {
        return Err("Not a file".into());
    }
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("File is too large to open (>5MB)".into());
    }
    fs::read_to_string(&file).map_err(|e| format!("Could not read file as text: {e}"))
}

/// Writes contents back to a real, already-existing file inside the
/// project root. The Code Workspace only edits files that were opened
/// from the tree — it doesn't create new files today, so `resolve_within_root`
/// (which requires the target to already exist) is the right guard here too.
#[tauri::command]
fn code_write_file(root: String, rel_path: String, contents: String) -> Result<(), String> {
    let file = resolve_within_root(&root, &rel_path)?;
    if !file.is_file() {
        return Err("Not a file".into());
    }
    fs::write(&file, contents).map_err(|e| e.to_string())
}

/// Creates a real, brand-new file inside the project root (e.g. a
/// generated test file) — never clobbers an existing one. Unlike the
/// other fs commands, `rel_path`'s target doesn't exist yet, so this
/// resolves the *parent* directory through `resolve_within_root` (which
/// still requires the parent to exist and stay inside the root) and
/// appends the final path segment itself, rather than canonicalizing a
/// path that isn't there yet.
#[tauri::command]
fn code_create_file(root: String, rel_path: String, contents: String) -> Result<(), String> {
    let rel = rel_path.replace('\\', "/");
    let (parent_rel, file_name) = match rel.rsplit_once('/') {
        Some((p, f)) => (p, f),
        None => ("", rel.as_str()),
    };
    if file_name.is_empty() || file_name == "." || file_name == ".." {
        return Err("Invalid file name".into());
    }
    let parent = resolve_within_root(&root, parent_rel)?;
    if !parent.is_dir() {
        return Err("Parent directory does not exist".into());
    }
    let file = parent.join(file_name);
    if file.exists() {
        return Err("A file already exists at this path".into());
    }
    fs::write(&file, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            environment_ping,
            code_read_dir,
            code_read_file,
            code_write_file,
            code_create_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AURA Hub");
}
