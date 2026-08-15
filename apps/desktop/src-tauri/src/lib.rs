//! AURA Hub — Tauri core.
//!
//! Deliberately thin. The desktop wrapper hosts the web environment in a
//! native window and owns the lifecycle of AURA's local service. Native
//! capabilities are exposed as tightly-scoped `#[tauri::command]`s — one
//! clean seam between the environment and the operating system.
//!
//! What this layer deliberately does NOT do is execute anything on the
//! user's behalf. There is no shell command here, no spawn-what-you-are-
//! told, no filesystem escape: the only process this shell ever starts is
//! AURA's own service, and every tool invocation continues to travel the
//! governed path (Capability Fabric → policy → approval → audit). The
//! desktop shell must not become a way around that.

mod service;

use serde::Serialize;
use service::{ServiceHandle, Startup, DEFAULT_PORT};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent};

/// A trivial command kept as a wiring example / health check for the
/// JS <-> Rust bridge. Remove or replace when real commands land.
#[tauri::command]
fn environment_ping() -> String {
    "aura://ready".to_string()
}

/// How this copy of AURA Hub was installed, which decides whether the
/// updater can replace it in place.
///
/// Read-only and argument-free: it inspects the process's own environment
/// and nothing else. It executes nothing, downloads nothing, and cannot be
/// pointed at anything by a caller — the renderer may ask *what am I*, and
/// that is the whole of it.
///
/// Linux is the only platform where this is ambiguous. Tauri's Linux
/// updater replaces the running AppImage, which sets `APPIMAGE` for the
/// process it launches; a `.deb` install has no such variable and is owned
/// by the system package manager, which the updater must not fight.
/// Windows and macOS installs are always self-updating.
#[tauri::command]
fn update_install_kind() -> String {
    #[cfg(target_os = "linux")]
    {
        match std::env::var("APPIMAGE") {
            Ok(v) if !v.is_empty() => "self-updating".to_string(),
            _ => "managed".to_string(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "self-updating".to_string()
    }
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

/* ── local service supervision ───────────────────────────────────── */

/// What the shell knows about the local service, as the UI sees it.
#[derive(Clone, Serialize)]
pub struct ServiceStatus {
    /// `starting` | `ready` | `failed`
    state: String,
    /// `reused` when a compatible service was already running, `spawned`
    /// when this process started it, empty otherwise. The distinction is
    /// not cosmetic — it is who owns shutdown.
    origin: String,
    /// Plain-language detail. Carries the reason on failure.
    message: String,
    port: u16,
}

pub struct ServiceState {
    handle: ServiceHandle,
    port: u16,
    status: Mutex<ServiceStatus>,
}

/// Where the packaged service bundle lives.
///
/// Two resolutions, in order of trust: the packaged resource directory
/// (the real answer in an installed application), then the repository's
/// build output (the answer while developing). Nothing is guessed — if
/// neither exists the caller reports an incomplete installation rather
/// than starting something arbitrary.
fn resolve_service_script(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(packaged) = app.path().resolve("resources/ai-service.mjs", BaseDirectory::Resource) {
        if packaged.is_file() {
            return Some(strip_verbatim(packaged));
        }
    }
    // `CARGO_MANIFEST_DIR` is apps/desktop/src-tauri; the repo root is three up.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(".aura/ai-service.mjs");
    dev.canonicalize().ok().filter(|p| p.is_file()).map(strip_verbatim)
}

/// Turn a Windows verbatim path back into an ordinary one.
///
/// `canonicalize` and Tauri's resource resolver both hand back verbatim
/// paths on Windows (`\\?\D:\…`). Rust and the Win32 API are perfectly
/// happy with those; **Node is not**. Given one as its main module it
/// parses the device root, tries to `lstat` the bare drive letter, and
/// dies with `EISDIR: illegal operation on a directory, lstat 'D:'` —
/// which surfaces to the user as the service "stopping while starting up"
/// with no indication that a path form was the cause.
///
/// The prefix exists to lift MAX_PATH and separator normalisation, neither
/// of which matters for a path we are about to hand to another program, so
/// dropping it costs nothing and makes the child able to read it.
/// Guarded with `cfg!` rather than `#[cfg]` on purpose: a `#[cfg(windows)]`
/// body is not compiled on Linux, so the one branch that only ever runs on
/// Windows would be the one branch no Linux build ever type-checks. This
/// way the developer machine and the Linux CI runner both compile it, and
/// only its execution is platform-specific. No Unix path begins with
/// `\\?\`, so the check is inert there in any case.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return p;
    }
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// The service's current condition, re-checked on every call.
///
/// Deliberately live rather than cached: a service that crashed after a
/// clean start must not keep reporting `ready`, or the UI would go on
/// claiming an execution backend that is gone.
#[tauri::command]
fn service_status(state: tauri::State<'_, ServiceState>) -> ServiceStatus {
    let mut status = state.status.lock().unwrap();
    if status.state == "ready" && !service::is_healthy(state.port) {
        status.state = "failed".into();
        status.message = "AURA's local service stopped responding.".into();
    }
    status.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Installed before anything is spawned, so there is no window in which
    // a termination signal could leave a service behind.
    service::install_termination_handlers();

    let port = std::env::var("AI_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let builder = tauri::Builder::default();

    // The updater and the restart it needs. Registered before anything
    // else so the plugin is available for the whole app lifetime.
    //
    // `cfg` rather than an unconditional call because the plugins are
    // declared under the same desktop cfg in Cargo.toml — on any other
    // target the crates are absent and this would not compile.
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let app = builder
        .manage(ServiceState {
            handle: ServiceHandle::new(port),
            port,
            status: Mutex::new(ServiceStatus {
                state: "starting".into(),
                origin: String::new(),
                message: "Starting AURA's local service…".into(),
                port,
            }),
        })
        .invoke_handler(tauri::generate_handler![
            environment_ping,
            service_status,
            code_read_dir,
            code_read_file,
            code_write_file,
            code_create_file,
            update_install_kind,
        ])
        .setup(move |app| {
            let script = resolve_service_script(app);
            let handle = app.handle().clone();

            // Off the UI thread: startup can take seconds (module load,
            // knowledge index), and blocking here would freeze the shell.
            // The window is configured hidden and is shown below, so the
            // user never sees a live window pointed at a dead backend.
            std::thread::spawn(move || {
                let state = handle.state::<ServiceState>();
                let outcome = match script {
                    Some(path) => service::ensure_running(&state.handle, path, port),
                    None => Err("AURA's local service bundle is missing from this installation.".to_string()),
                };

                {
                    let mut status = state.status.lock().unwrap();
                    *status = match &outcome {
                        Ok(Startup::Reused) => ServiceStatus {
                            state: "ready".into(),
                            origin: "reused".into(),
                            message: format!("Connected to the AURA service already running on port {port}."),
                            port,
                        },
                        Ok(Startup::Spawned) => ServiceStatus {
                            state: "ready".into(),
                            origin: "spawned".into(),
                            message: format!("AURA's local service is ready on port {port}."),
                            port,
                        },
                        Err(message) => ServiceStatus {
                            state: "failed".into(),
                            origin: String::new(),
                            message: message.clone(),
                            port,
                        },
                    };
                }

                if let Err(message) = &outcome {
                    // Goes to the launcher's journal, and to the log the
                    // failure message points the user at.
                    eprintln!("AURA Hub: {message}");
                }

                // Shown either way. A failed start still deserves a window
                // that can explain itself; a permanently invisible app
                // would be the least honest outcome available.
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AURA Hub");

    app.run(|app_handle, event| {
        // Quitting AURA must not leave its service running. `shutdown` only
        // signals a child this process actually spawned, so a developer's
        // own `npm run ai` survives the app closing.
        if let RunEvent::Exit = event {
            app_handle.state::<ServiceState>().handle.shutdown();
        }
    });
}
