//! The Code workspace's terminal: the user's own shell, in a project folder.
//!
//! Each session is a real pseudo-terminal running the user's login shell
//! (`$SHELL` on Linux/macOS, PowerShell on Windows) with the project folder as
//! its working directory. Output streams to the renderer as `shell-output`
//! events and the end of the shell as `shell-exit`, both tagged with the
//! session id `shell_start` returned.
//!
//! The shell starts with a clean environment. Inside an AppImage the runtime
//! points LD_LIBRARY_PATH, PYTHONHOME, PATH and a dozen GTK variables into its
//! own mount; a user's `python`, `git` or `perl` started under those breaks in
//! confusing ways. Those are removed, and the hub's private instance token is
//! never passed on.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pty::take_utf8;
use crate::service;

/// More than this many shells open at once is almost certainly a leak, not a user.
const MAX_SESSIONS: usize = 8;

/// Never handed to a user's shell, AppImage or not.
const ALWAYS_DROP: &[&str] = &["AURA_INSTANCE_TOKEN"];

/// Set by the AppImage runtime (or by Tauri for its own window) and wrong for anything else.
const APPIMAGE_DROP: &[&str] = &[
    "APPDIR", "APPIMAGE", "ARGV0", "OWD",
    "LD_LIBRARY_PATH", "PYTHONHOME", "PYTHONPATH", "PERLLIB", "QT_PLUGIN_PATH",
    "GDK_BACKEND", "GDK_PIXBUF_MODULE_FILE", "GIO_EXTRA_MODULES", "GI_TYPELIB_PATH",
    "GSETTINGS_SCHEMA_DIR", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GTK_DATA_PREFIX", "GTK_EXE_PREFIX", "GTK_IM_MODULE_FILE", "GTK_PATH", "GTK_THEME",
];

/// Variables holding a list of directories, from which the AppImage mount is removed.
const PATH_LISTS: &[&str] = &["PATH", "XDG_DATA_DIRS"];

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct ShellPty {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u32,
    code: u32,
}

/// The environment a user's shell gets: the hub's own, minus what belongs to the hub.
///
/// `appdir` is the AppImage mount when running from one; without it only the
/// always-private variables are removed, so a `.deb`, macOS or Windows install
/// passes the user's environment through untouched.
fn clean_env(vars: impl IntoIterator<Item = (String, String)>, appdir: Option<&str>) -> Vec<(String, String)> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let appdir = appdir.map(|d| d.trim_end_matches('/')).filter(|d| !d.is_empty());
    vars.into_iter()
        .filter(|(k, _)| !ALWAYS_DROP.contains(&k.as_str()))
        .filter(|(k, _)| appdir.is_none() || !APPIMAGE_DROP.contains(&k.as_str()))
        .filter_map(|(k, v)| match appdir {
            Some(dir) if PATH_LISTS.contains(&k.as_str()) => {
                let kept: Vec<&str> = v.split(sep).filter(|p| !p.is_empty() && !p.starts_with(dir)).collect();
                (!kept.is_empty()).then(|| (k, kept.join(&sep.to_string())))
            }
            _ => Some((k, v)),
        })
        .collect()
}

/// The user's shell and the arguments that make it a login shell (so nvm, pyenv
/// and anything else set up in the profile is on PATH, as in their own terminal).
fn user_shell() -> (PathBuf, Vec<&'static str>) {
    #[cfg(windows)]
    {
        if let Some(ps) = which_on_path("powershell.exe") {
            return (ps, vec!["-NoLogo"]);
        }
        let cmd = std::env::var_os("COMSPEC").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
        (cmd, vec![])
    }
    #[cfg(not(windows))]
    {
        let from_env = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_file());
        let shell = from_env
            .or_else(|| ["/bin/zsh", "/bin/bash", "/bin/sh"].iter().map(PathBuf::from).find(|p| p.is_file()))
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let name = shell.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let args = if matches!(name, "bash" | "zsh" | "fish" | "ksh") { vec!["-l"] } else { vec![] };
        (shell, args)
    }
}

#[cfg(windows)]
fn which_on_path(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe)).find(|c| c.is_file()))
}

/// The folder the shell starts in: must be an existing directory.
fn resolve_cwd(cwd: &str) -> Result<PathBuf, String> {
    let p = Path::new(cwd);
    if cwd.trim().is_empty() || !p.is_absolute() {
        return Err("the terminal needs the project's full folder path".into());
    }
    if !p.is_dir() {
        return Err(format!("the project folder {cwd} does not exist"));
    }
    Ok(p.to_path_buf())
}

/// The user's shell, in `cwd`, with the cleaned environment. Shared by `shell_start` and the tests.
fn shell_command(cwd: &Path) -> (PathBuf, CommandBuilder) {
    let (shell, args) = user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(&args);
    cmd.cwd(cwd);

    let appdir = std::env::var("APPDIR").ok().filter(|_| std::env::var_os("APPIMAGE").is_some());
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    // The PATH the rest of AURA uses for agents: the user's own first, then ~/.local/bin, ~/.aura/tools and so on.
    env.retain(|(k, _)| k != "PATH");
    env.push(("PATH".into(), service::augmented_path(None)));
    cmd.env_clear();
    for (k, v) in clean_env(env, appdir.as_deref()) {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "AURA Hub");
    (shell, cmd)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

#[tauri::command]
pub fn shell_start(app: AppHandle, state: State<'_, ShellPty>, cwd: String, cols: u16, rows: u16) -> Result<u32, String> {
    let cwd = resolve_cwd(&cwd)?;
    if state.sessions.lock().unwrap().len() >= MAX_SESSIONS {
        return Err(format!("at most {MAX_SESSIONS} terminals can be open at once; close one first"));
    }

    let pty = native_pty_system().openpty(size(cols, rows)).map_err(|e| format!("could not open a terminal: {e}"))?;
    let (shell, cmd) = shell_command(&cwd);

    let mut child = pty
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {}: {e}", shell.display()))?;
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;

    let out_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() {
                        let _ = out_app.emit("shell-output", Output { id, data });
                    }
                }
            }
        }
    });

    let exit_app = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        exit_app.state::<ShellPty>().sessions.lock().unwrap().remove(&id);
        let _ = exit_app.emit("shell-exit", Exit { id, code });
    });

    state.sessions.lock().unwrap().insert(id, Session { writer, master: pty.master, killer });
    Ok(id)
}

#[tauri::command]
pub fn shell_write(state: State<'_, ShellPty>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("this terminal has ended")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shell_resize(state: State<'_, ShellPty>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("this terminal has ended")?;
    s.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shell_stop(state: State<'_, ShellPty>, id: u32) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
}

/// Every shell ends with the hub: called on exit so none outlives it.
pub fn stop_all(state: &ShellPty) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        let _ = s.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn the_instance_token_never_reaches_the_shell() {
        let env = clean_env(kv(&[("AURA_INSTANCE_TOKEN", "secret"), ("HOME", "/home/u")]), None);
        assert_eq!(get(&env, "AURA_INSTANCE_TOKEN"), None);
        assert_eq!(get(&env, "HOME"), Some("/home/u"));
    }

    #[test]
    fn outside_an_appimage_the_environment_is_kept() {
        let env = clean_env(kv(&[("LD_LIBRARY_PATH", "/opt/lib"), ("PYTHONPATH", "/src")]), None);
        assert_eq!(get(&env, "LD_LIBRARY_PATH"), Some("/opt/lib"));
        assert_eq!(get(&env, "PYTHONPATH"), Some("/src"));
    }

    #[cfg(unix)]
    #[test]
    fn appimage_variables_and_mount_paths_are_removed() {
        let m = "/tmp/.mount_AURA-x";
        let env = clean_env(
            kv(&[
                ("APPDIR", m),
                ("LD_LIBRARY_PATH", "/tmp/.mount_AURA-x/usr/lib/"),
                ("PYTHONHOME", "/tmp/.mount_AURA-x/usr/"),
                ("GTK_PATH", "/tmp/.mount_AURA-x//usr/lib/gtk-3.0"),
                ("PATH", "/tmp/.mount_AURA-x/usr/bin/:/usr/bin:/home/u/.local/bin"),
                ("XDG_DATA_DIRS", "/tmp/.mount_AURA-x/usr/share/:/usr/share:"),
                ("LANG", "en_US.UTF-8"),
            ]),
            Some(m),
        );
        for k in ["APPDIR", "LD_LIBRARY_PATH", "PYTHONHOME", "GTK_PATH"] {
            assert_eq!(get(&env, k), None, "{k} should be removed");
        }
        assert_eq!(get(&env, "PATH"), Some("/usr/bin:/home/u/.local/bin"));
        assert_eq!(get(&env, "XDG_DATA_DIRS"), Some("/usr/share"));
        assert_eq!(get(&env, "LANG"), Some("en_US.UTF-8"));
    }

    #[test]
    fn the_folder_must_exist_and_be_absolute() {
        assert!(resolve_cwd("").is_err());
        assert!(resolve_cwd("relative/dir").is_err());
        assert!(resolve_cwd(&std::env::temp_dir().join("aura-no-such-dir-x9").to_string_lossy()).is_err());
        let tmp = std::env::temp_dir();
        assert_eq!(resolve_cwd(&tmp.to_string_lossy()).unwrap(), tmp);
    }

    /// End to end through a real pseudo-terminal: the shell starts in the
    /// project folder, runs what is typed, and never sees the instance token.
    #[cfg(unix)]
    #[test]
    fn a_real_shell_runs_commands_in_the_project_folder() {
        let dir = std::env::temp_dir().join(format!("aura-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        std::env::set_var("AURA_INSTANCE_TOKEN", "must-not-leak");

        let pty = native_pty_system().openpty(size(120, 30)).unwrap();
        let (_shell, cmd) = shell_command(&dir);
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut writer = pty.master.take_writer().unwrap();
        writer
            .write_all(b"echo \"cwd=[$(pwd -P)] token=[${AURA_INSTANCE_TOKEN:-none}]\"; exit 0\n")
            .unwrap();
        writer.flush().unwrap();

        let reading = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
            String::from_utf8_lossy(&out).into_owned()
        });
        let status = child.wait().unwrap();
        drop(pty.master);
        let out = reading.join().unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert!(status.success(), "shell exited with {status:?}: {out}");
        assert!(out.contains(&format!("cwd=[{}]", dir.display())), "wrong folder: {out}");
        assert!(out.contains("token=[none]"), "the instance token leaked: {out}");
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_is_chosen() {
        let (shell, _args) = user_shell();
        assert!(shell.is_file(), "{} should exist", shell.display());
    }
}
