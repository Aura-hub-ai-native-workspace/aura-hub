//! The terminal panel behind the one sign-in page.
//!
//! Each coding agent signs in with its own interactive login (a menu, a code
//! to paste back, a browser that opens). That needs a real pseudo-terminal, so
//! this runs `aura-agents login <agent>` in one and streams it to the panel.
//!
//! Deliberately narrow: the only program it starts is AURA's own setup script
//! with the `login` subcommand, and the agent must be one of the six known ids.
//! The renderer cannot pass a command, arguments or a working directory.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::service;

/// The agents the sign-in page may start a login for (the workspace's agents are a subset).
pub const AGENT_IDS: [&str; 7] = ["opencode", "kilo-code", "freebuff", "claude-code", "codex-cli", "agy", "pi"];

struct Session {
    agent: String,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct LoginPty {
    session: Mutex<Option<Session>>,
}

#[derive(Clone, Serialize)]
struct Output {
    agent: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    agent: String,
    code: u32,
}

/// The setup script: packaged copy first, then the repository's.
fn agents_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve("resources/setup/aura-agents.mjs", BaseDirectory::Resource) {
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/agents/aura-agents.mjs");
    dev.canonicalize().ok().filter(|p| p.is_file())
}

/// Bytes to text without splitting a multi-byte character across two events.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

fn stop_session(state: &LoginPty) {
    if let Some(mut s) = state.session.lock().unwrap().take() {
        let _ = s.killer.kill();
    }
}

#[tauri::command]
pub fn agent_login_start(app: AppHandle, state: State<'_, LoginPty>, agent: String, cols: u16, rows: u16) -> Result<(), String> {
    if !AGENT_IDS.contains(&agent.as_str()) {
        return Err(format!("unknown agent \"{agent}\""));
    }
    stop_session(&state);

    let script = agents_script(&app).ok_or("AURA's agent setup script is missing from this install")?;
    let bundled_node = script
        .parent()
        .and_then(|setup| setup.parent())
        .map(|resources| resources.join("runtime").join("node").join(if cfg!(windows) { "node.exe" } else { "bin/node" }));
    let node = service::resolve_node(bundled_node.as_deref())?;

    let pty = native_pty_system()
        .openpty(PtySize { rows: rows.max(5), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("could not open a terminal: {e}"))?;
    let mut cmd = CommandBuilder::new(node);
    cmd.arg(script);
    cmd.arg("login");
    cmd.arg(&agent);
    cmd.cwd(service::home_dir());
    cmd.env("PATH", service::augmented_path(None));
    cmd.env("TERM", "xterm-256color");
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| format!("could not start the sign-in: {e}"))?;
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let out_app = app.clone();
    let out_agent = agent.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() {
                        let _ = out_app.emit("agent-login-output", Output { agent: out_agent.clone(), data });
                    }
                }
            }
        }
    });

    let exit_app = app.clone();
    let exit_agent = agent.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let state = exit_app.state::<LoginPty>();
        let mut guard = state.session.lock().unwrap();
        if guard.as_ref().is_some_and(|s| s.agent == exit_agent) {
            *guard = None;
        }
        drop(guard);
        let _ = exit_app.emit("agent-login-exit", Exit { agent: exit_agent, code });
    });

    *state.session.lock().unwrap() = Some(Session { agent, writer, master: pty.master, killer });
    Ok(())
}

#[tauri::command]
pub fn agent_login_write(state: State<'_, LoginPty>, data: String) -> Result<(), String> {
    let mut guard = state.session.lock().unwrap();
    let s = guard.as_mut().ok_or("no sign-in is running")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_login_resize(state: State<'_, LoginPty>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.session.lock().unwrap();
    let s = guard.as_ref().ok_or("no sign-in is running")?;
    s.master
        .resize(PtySize { rows: rows.max(5), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_login_stop(state: State<'_, LoginPty>) {
    stop_session(&state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_known_agents_are_allowed() {
        assert_eq!(AGENT_IDS.len(), 7);
        assert!(!AGENT_IDS.contains(&"bash"));
        assert!(!AGENT_IDS.iter().any(|a| a.contains(' ') || a.contains('/')));
    }

    #[test]
    fn utf8_split_across_reads_is_kept_whole() {
        let mut pending = "a€".as_bytes()[..2].to_vec(); // 'a' + first byte of '€'
        assert_eq!(take_utf8(&mut pending), "a");
        pending.extend_from_slice(&"€".as_bytes()[1..]);
        assert_eq!(take_utf8(&mut pending), "€");
        assert!(pending.is_empty());
    }
}
